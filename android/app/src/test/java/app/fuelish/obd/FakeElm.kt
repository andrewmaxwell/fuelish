package app.fuelish.obd

import java.io.IOException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Minimal ELM327/STN emulator for tests: CAN 11-bit with headers on, one ECU at 7E8,
 * ISO-TP framing for long responses. Not a Civic model — just enough protocol behaviour.
 */
class FakeElm(
    val supported: Set<Int> = setOf(0x01, 0x04, 0x05, 0x06, 0x07, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x13, 0x1C, 0x1F, 0x2F, 0x33, 0x42, 0x44, 0x46, 0x49),
    var vehicleOn: Boolean = true,
    val maxMultiPid: Int = 6,
    val vin: String = "2HGFC2F5XGH000000",
    /** What the car says while off: older stacks error out, the Civic answers NO DATA. */
    var offReply: String = "SEARCHING...\rUNABLE TO CONNECT",
) : ObdTransport {
    val received = mutableListOf<String>()
    private val out = LinkedBlockingQueue<ByteArray>()
    private val inBuf = StringBuilder()
    @Volatile var closed = false
    @Volatile var dropLink = false

    override fun write(bytes: ByteArray) {
        if (closed || dropLink) throw IOException("link down")
        for (b in bytes) {
            val c = b.toInt().toChar()
            if (c == '\r') {
                val cmd = inBuf.toString().trim().uppercase()
                inBuf.clear()
                received += cmd
                out.put((respond(cmd) + "\r\r>").toByteArray())
            } else inBuf.append(c)
        }
    }

    override fun read(timeoutMs: Long): ByteArray? {
        if (closed || dropLink) throw IOException("link down")
        return out.poll(timeoutMs, TimeUnit.MILLISECONDS)
    }

    override fun close() {
        closed = true
    }

    private fun bitmap(base: Int): String {
        var v = 0L
        for (i in 1..32) {
            val pid = base + i
            if (pid in supported || (i == 32 && supported.any { it > base + 32 })) v = v or (1L shl (32 - i))
        }
        return "%08X".format(v)
    }

    private fun value(pid: Int): String? = when (pid) {
        0x0C -> "1AF8"
        0x0D -> "32"
        0x0B -> "21"
        0x10 -> "0190"
        0x42 -> "3200"
        0x44 -> "8000"
        0x1F -> "0100"
        0x01 -> "00076500"
        else -> Pids.all[pid]?.let { "7F".repeat(it.bytes) }
    }

    private fun frames(payloadHex: String): String {
        val bytes = payloadHex.length / 2
        if (bytes <= 7) return "7E8%02X%s".format(bytes, payloadHex)
        val sb = StringBuilder("7E81%03X%s".format(bytes, payloadHex.take(12)))
        var rest = payloadHex.drop(12)
        var n = 1
        while (rest.isNotEmpty()) {
            sb.append("\r7E82%X%s".format(n and 0xF, rest.take(14).padEnd(14, '0')))
            rest = rest.drop(14)
            n++
        }
        return sb.toString()
    }

    fun respond(cmd: String): String = when {
        cmd == "ATZ" || cmd == "ATI" -> "ELM327 v1.4b"
        cmd == "STDI" -> "OBDLink MX+ r1.2"
        cmd == "STI" -> "STN2255 v5.6.19"
        cmd == "ATRV" -> "12.6V"
        cmd == "ATDPN" -> "A6"
        cmd == "ATDP" -> "AUTO, ISO 15765-4 (CAN 11/500)"
        cmd.startsWith("AT") || cmd.startsWith("ST") -> "OK"
        !vehicleOn -> offReply
        cmd == "0900" -> frames("4900" + "54400000")
        cmd == "0902" -> frames("490201" + vin.map { "%02X".format(it.code) }.joinToString(""))
        cmd == "03" -> frames("4300")
        cmd == "07" -> frames("4700")
        cmd.startsWith("01") -> {
            val pids = cmd.drop(2).chunked(2).map { it.toInt(16) }
            if (pids.size > maxMultiPid) "?"
            else {
                val parts = pids.mapNotNull { p ->
                    when {
                        Pids.isBitmapPid(p) -> "%02X".format(p) + bitmap(p)
                        p in supported -> value(p)?.let { "%02X".format(p) + it }
                        else -> null
                    }
                }
                if (parts.isEmpty()) "NO DATA" else frames("41" + parts.joinToString(""))
            }
        }
        else -> "NO DATA"
    }
}
