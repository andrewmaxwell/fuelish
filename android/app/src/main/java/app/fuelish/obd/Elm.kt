package app.fuelish.obd

import java.io.Closeable
import java.io.IOException

/** Byte pipe to an ELM327-compatible adapter (Bluetooth SPP in the app, a fake in tests). */
interface ObdTransport : Closeable {
    fun write(bytes: ByteArray)

    /** Returns available bytes, or null if nothing arrived within [timeoutMs]. Throws on disconnect. */
    fun read(timeoutMs: Long): ByteArray?
}

enum class ElmStatus { OK, NO_DATA, ERROR, TIMEOUT }

data class ElmResponse(
    val cmd: String,
    /** Exact text the adapter returned before the `>` prompt (CRs preserved). */
    val raw: String,
    /** Non-empty lines with echo and progress messages (SEARCHING...) removed. */
    val lines: List<String>,
    val sentNs: Long,
    val doneNs: Long,
    val status: ElmStatus,
) {
    val latencyNs get() = doneNs - sentNs
}

/**
 * Commands the app is allowed to send. Everything is read-only: adapter configuration
 * (AT/ST), mode 01 current data, mode 03/07/0A stored/pending/permanent DTC reads, and
 * mode 09 vehicle info. Modes that clear codes (04), run tests (08) or anything else are
 * rejected before reaching the adapter.
 */
object ElmAllowlist {
    private val allowed = listOf(
        Regex("AT(Z|WS|D|E[01]|L[01]|S[01]|H[01]|SP[0-9A-C]|TP[0-9A-C]|DPN?|RV|I|@1|AT[012]|ST[0-9A-F]{2}|CAF[01]|M0)"),
        Regex("ST(I|DI|SN)"),
        Regex("01([0-9A-F]{2}){1,6}[1-9]?"),
        Regex("09[0-9A-F]{2}"),
        Regex("0[37A]"),
    )

    fun check(cmd: String) {
        require(allowed.any { it.matches(cmd) }) { "command not allowlisted: $cmd" }
    }
}

class ElmSession(
    private val transport: ObdTransport,
    private val nanoTime: () -> Long,
    /** Called for every exchange so raw traffic can be recorded. */
    private val onExchange: (ElmResponse) -> Unit = {},
) {
    private val pending = StringBuilder()

    fun cmd(cmd: String, timeoutMs: Long = 2_000): ElmResponse {
        ElmAllowlist.check(cmd)
        pending.clear()
        val sent = nanoTime()
        transport.write((cmd + "\r").toByteArray(Charsets.US_ASCII))
        val buf = StringBuilder()
        val deadline = sent + timeoutMs * 1_000_000
        var timedOut = false
        while (true) {
            val remainingMs = (deadline - nanoTime()) / 1_000_000
            if (remainingMs <= 0) {
                timedOut = true
                break
            }
            val chunk = transport.read(remainingMs) ?: continue
            buf.append(String(chunk, Charsets.ISO_8859_1))
            val p = buf.indexOf(">")
            if (p >= 0) {
                buf.setLength(p) // anything after the prompt is noise
                break
            }
        }
        val done = nanoTime()
        val raw = buf.toString()
        val lines = raw.split('\r', '\n').map { it.trim() }.filter {
            it.isNotEmpty() && it != cmd && !it.startsWith("SEARCHING") && it != "OK" && !it.startsWith("BUS INIT")
        }
        val status = when {
            timedOut -> ElmStatus.TIMEOUT
            lines.any { it.startsWith("NO DATA") } -> ElmStatus.NO_DATA
            lines.any { ERRORS.any { e -> it.startsWith(e) } } -> ElmStatus.ERROR
            else -> ElmStatus.OK
        }
        val r = ElmResponse(cmd, raw, lines, sent, done, status)
        onExchange(r)
        return r
    }

    companion object {
        val ERRORS = listOf(
            "?", "UNABLE TO CONNECT", "CAN ERROR", "BUS ERROR", "BUS BUSY", "BUFFER FULL", "STOPPED",
            "ERR", "FB ERROR", "DATA ERROR", "LV RESET", "ACT ALERT", "<RX ERROR", "<DATA ERROR",
        )
    }
}

/** One reassembled response message from one ECU. */
data class ObdMessage(val ecu: String, val payload: ByteArray)

/**
 * Turns adapter lines into messages. Supports the headers-on formats we configure
 * (ATH1, ATS0): CAN 11-bit ("7E8" + PCI + data), CAN 29-bit ("18DAF110" + PCI + data)
 * with ISO-TP multi-frame reassembly, and legacy protocols (3 header bytes + data + checksum).
 * Raw text is always recorded separately, so anything this cannot parse is not lost.
 */
object ObdParser {
    fun isCan(protocol: Int) = protocol in 6..9 || protocol in 0xA..0xC
    fun headerHexLen(protocol: Int) = when (protocol) {
        6, 8, 0xB -> 3
        7, 9, 0xC -> 8
        else -> 6
    }

    fun parse(lines: List<String>, protocol: Int): List<ObdMessage> {
        val can = isCan(protocol)
        val hl = headerHexLen(protocol)
        val out = mutableListOf<ObdMessage>()
        val partial = HashMap<String, Pair<Int, MutableList<Byte>>>() // ecu -> (expected length, bytes)
        for (line in lines) {
            val l = line.replace(" ", "")
            if (l.length <= hl || !l.all { it.isHex() }) continue
            val ecu = l.substring(0, hl)
            val data = hexToBytes(l.substring(hl)) ?: continue
            if (!can) {
                if (data.size >= 2) out += ObdMessage(ecu, data.copyOf(data.size - 1)) // drop checksum
                continue
            }
            if (data.isEmpty()) continue
            val pci = data[0].toInt() and 0xFF
            when (pci shr 4) {
                0 -> {
                    val len = pci and 0x0F
                    if (len in 1..(data.size - 1)) out += ObdMessage(ecu, data.copyOfRange(1, 1 + len))
                }
                1 -> {
                    if (data.size < 2) continue
                    val len = ((pci and 0x0F) shl 8) or (data[1].toInt() and 0xFF)
                    partial[ecu] = len to data.copyOfRange(2, data.size).toMutableList()
                }
                2 -> {
                    val p = partial[ecu] ?: continue
                    p.second.addAll(data.copyOfRange(1, data.size).toList())
                    if (p.second.size >= p.first) {
                        out += ObdMessage(ecu, p.second.take(p.first).toByteArray())
                        partial.remove(ecu)
                    }
                }
            }
        }
        return out
    }

    fun hexToBytes(s: String): ByteArray? {
        if (s.length % 2 != 0) return null
        return ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }

    fun toHex(b: ByteArray, from: Int = 0, to: Int = b.size): String {
        val sb = StringBuilder()
        for (i in from until to) sb.append("%02X".format(b[i].toInt() and 0xFF))
        return sb.toString()
    }

    private fun Char.isHex() = this in '0'..'9' || this in 'A'..'F' || this in 'a'..'f'
}

class ObdDisconnected(msg: String, cause: Throwable? = null) : IOException(msg, cause)
