package app.fuelish.obd

import app.fuelish.Config
import app.fuelish.record.JsonLine
import app.fuelish.record.RecordSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

data class ObdStatus(
    val state: String = "off",
    val detail: String = "",
    val adapter: String = "",
    val protocol: String = "",
    val vin: String = "",
    val supportedPids: Int = 0,
    val maxBatch: Int = 0,
    val requestsPerSec: Double = 0.0,
    val meanLatencyMs: Double = 0.0,
    val adapterVolts: String = "",
    val values: Map<String, String> = emptyMap(),
)

/**
 * Talks to the adapter on its own thread: connect, initialise, discover what the car
 * supports, benchmark request shapes, then poll until stopped. Every exchange is recorded
 * raw (`obd_raw`) as well as decoded (`obd`). Disconnects and an unresponsive car (ignition
 * off) are retried forever with backoff; phone recording never depends on this.
 */
class ObdRecorder(
    private val cfg: JSONObject,
    private val connect: () -> ObdTransport,
    private val sink: RecordSink,
    private val nanoTime: () -> Long,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
) {
    @Volatile var status = ObdStatus()
        private set
    @Volatile private var running = false
    private var thread: Thread? = null
    private var transport: ObdTransport? = null

    /** Snapshot for recording metadata; written from the OBD thread, read at stop. */
    val summary = JSONObject()

    private var protocol = 0
    private var supported = sortedSetOf<Int>()
    private var maxBatch = 1

    // Rolling stats for status and obd_stats records.
    private var statWindowStart = 0L
    private var statRequests = 0
    private var statLatencyNs = 0L
    private val pidCounts = HashMap<Int, Long>()

    fun start() {
        running = true
        thread = Thread(::run, "fuelish-obd").also { it.start() }
    }

    fun stop() {
        running = false
        runCatching { transport?.close() } // unblocks a pending read/connect
        thread?.join(5_000)
        status = status.copy(state = "off")
    }

    private fun setState(state: String, detail: String = "") {
        status = status.copy(state = state, detail = detail)
    }

    private fun event(ev: String, detail: String = "") {
        val now = nanoTime()
        sink.emit("obd_event", now, JsonLine("obd_event").n("rx", now).s("ev", ev).s("detail", detail).build())
    }

    private fun run() {
        var backoffMs = 2_000L
        var attempts = 0
        while (running) {
            try {
                setState("connecting")
                attempts++
                val t = connect()
                transport = t
                event("connected")
                backoffMs = 2_000L
                t.use { runConnected(it) }
            } catch (e: Exception) {
                if (!running) break
                event("disconnected", e.toString())
                setState("disconnected", "${e.message ?: e} — retrying in ${backoffMs / 1000}s")
                summary.put("connectAttempts", attempts)
            } finally {
                transport = null
            }
            if (!running) break
            sleep(backoffMs)
            backoffMs = minOf(backoffMs * 2, 30_000L)
        }
    }

    /** Runs until [running] goes false or the link fails (throws). Visible for tests. */
    fun runConnected(t: ObdTransport) {
        val session = ElmSession(t, nanoTime) { r -> recordRaw(r) }
        initAdapter(session)
        while (running) {
            if (!discoverVehicle(session)) {
                setState("waiting_vehicle", "no response from car (ignition off?)")
                sleep(5_000)
                continue
            }
            if (cfg.optBoolean("benchmark", true)) benchmark(session)
            poll(session)
        }
    }

    private fun recordRaw(r: ElmResponse) {
        sink.emit(
            "obd_raw", r.doneNs,
            JsonLine("obd_raw").n("tx", r.sentNs).n("rx", r.doneNs).s("cmd", r.cmd).s("st", r.status.name).s("resp", r.raw).build(),
        )
    }

    private fun initAdapter(s: ElmSession) {
        setState("initializing")
        val z = s.cmd("ATZ", 5_000)
        if (z.status == ElmStatus.TIMEOUT) throw ObdDisconnected("adapter did not answer ATZ")
        sleep(500)
        for (c in listOf("ATE0", "ATL0", "ATS0", "ATH1", "ATAT1")) s.cmd(c)
        s.cmd("ATSP" + cfg.optString("protocol", "0").uppercase())
        val info = JSONObject()
        for (c in listOf("ATI", "AT@1", "STI", "STDI", "ATRV")) {
            val r = s.cmd(c)
            if (r.status == ElmStatus.OK) info.put(c, r.lines.joinToString(" / "))
        }
        summary.put("adapter", info)
        val adapterName = info.optString("STDI").ifEmpty { info.optString("ATI") }
        status = status.copy(adapter = adapterName, adapterVolts = info.optString("ATRV"))
        event("adapter_ready", info.toString())
    }

    /** Returns false if the car does not answer (ignition off, wrong protocol, ...). */
    private fun discoverVehicle(s: ElmSession): Boolean {
        setState("discovering", "searching for protocol")
        val first = s.cmd("0100", 15_000)
        if (first.status == ElmStatus.TIMEOUT) throw ObdDisconnected("adapter stopped answering")
        if (first.status != ElmStatus.OK) return false

        val dpn = s.cmd("ATDPN").lines.firstOrNull().orEmpty().removePrefix("A")
        protocol = dpn.toIntOrNull(16) ?: 0
        val dp = s.cmd("ATDP").lines.firstOrNull().orEmpty()
        status = status.copy(protocol = dp)

        val perEcu = JSONObject()
        val all = sortedSetOf<Int>()
        var resp = first
        var base = 0x00
        while (true) {
            for (m in ObdParser.parse(resp.lines, protocol)) {
                val v = Mode01.split(m.payload, listOf(base)).firstOrNull { it.pid == base } ?: continue
                val pids = Pids.decodeBitmap(base, v.data)
                val arr = perEcu.optJSONArray(m.ecu) ?: JSONArray().also { perEcu.put(m.ecu, it) }
                pids.forEach { arr.put(Pids.hex(it)) }
                all += pids
            }
            val nextBase = base + 0x20
            if (nextBase > 0xE0 || nextBase !in all) break
            base = nextBase
            resp = s.cmd("01" + Pids.hex(base))
            if (resp.status != ElmStatus.OK) break
        }
        supported = all.filterTo(sortedSetOf()) { !Pids.isBitmapPid(it) }
        if (supported.isEmpty()) return false

        val discovery = JSONObject()
            .put("protocolNumber", dpn).put("protocol", dp)
            .put("supportedByEcu", perEcu)
            .put("supported", JSONArray(supported.map { Pids.hex(it) }))
            .put("unknownToDecoder", JSONArray(supported.filter { it !in Pids.all }.map { Pids.hex(it) }))
            .put("pidDefinitions", JSONObject().apply {
                supported.mapNotNull { Pids.all[it] }.forEach { d ->
                    put(Pids.hex(d.pid), JSONObject().put("name", d.name).put("bytes", d.bytes).put("fields", JSONArray(d.fields.map {
                        JSONObject().put("name", it.name).put("unit", it.unit).put("formula", it.formula)
                    })))
                }
            })

        if (cfg.optBoolean("readVehicleInfo", true)) discovery.put("vehicleInfo", readVehicleInfo(s))
        if (cfg.optBoolean("readDtcs", true)) {
            val dtc = JSONObject()
            for (c in listOf("03", "07", "0A")) {
                val r = s.cmd(c, 5_000)
                dtc.put(c, JSONObject().put("status", r.status.name).put("lines", JSONArray(r.lines)))
            }
            discovery.put("dtcRaw", dtc)
        }
        summary.put("connected", true)
        summary.put("protocol", dp)
        summary.put("discovery", discovery)
        val now = nanoTime()
        sink.emit("obd_discovery", now, JsonLine("obd_discovery").n("rx", now).raw("d", discovery.toString()).build())
        status = status.copy(supportedPids = supported.size)
        return true
    }

    private fun readVehicleInfo(s: ElmSession): JSONObject {
        val out = JSONObject()
        val r = s.cmd("0900")
        if (r.status != ElmStatus.OK) return out.put("supported", JSONArray())
        val sup = ObdParser.parse(r.lines, protocol).flatMap { m ->
            val p = m.payload.map { it.toInt() and 0xFF }
            if (p.size >= 6 && p[0] == 0x49 && p[1] == 0x00) Pids.decodeBitmap(0, p.subList(2, 6).toIntArray()) else emptyList()
        }.toSortedSet()
        out.put("supported", JSONArray(sup.map { Pids.hex(it) }))
        for (pid in listOf(0x02, 0x04, 0x06, 0x0A).filter { it in sup }) {
            val rr = s.cmd("09" + Pids.hex(pid), 5_000)
            val msgs = ObdParser.parse(rr.lines, protocol)
            out.put(Pids.hex(pid), JSONArray(msgs.map { m ->
                JSONObject().put("ecu", m.ecu).put("hex", ObdParser.toHex(m.payload))
                    .put("ascii", m.payload.drop(3).map { it.toInt().toChar() }.filter { it in ' '..'~' }.joinToString("").trim())
            }))
            if (pid == 0x02) {
                val vin = msgs.firstOrNull()?.payload?.drop(3)?.map { it.toInt().toChar() }?.filter { it.isLetterOrDigit() }?.joinToString("").orEmpty()
                if (vin.isNotEmpty()) {
                    out.put("vin", vin)
                    status = status.copy(vin = vin)
                }
            }
        }
        return out
    }

    /** Measures single-PID latency and finds the largest multi-PID request the ECU answers fully. */
    private fun benchmark(s: ElmSession) {
        setState("benchmarking")
        val bench = JSONObject()
        val fastCfg = Config.hexList(cfg.optJSONArray("fast"))
        val candidates = (fastCfg.filter { it in supported } + supported.filter { it !in fastCfg })
            .filter { Pids.all.containsKey(it) }.take(6)
        if (candidates.isEmpty()) {
            maxBatch = 1
            return
        }
        fun trial(pids: List<Int>, reps: Int): Pair<Boolean, List<Long>> {
            val lat = mutableListOf<Long>()
            var allOk = true
            repeat(reps) {
                val r = s.cmd("01" + pids.joinToString("") { Pids.hex(it) }, cfg.optLong("requestTimeoutMs", 2_000))
                if (r.status == ElmStatus.TIMEOUT) throw ObdDisconnected("timeout during benchmark")
                val got = ObdParser.parse(r.lines, protocol).flatMap { Mode01.split(it.payload, pids) }.map { it.pid }.toSet()
                if (!got.containsAll(pids)) allOk = false
                lat += r.latencyNs
            }
            return allOk to lat
        }
        fun stats(l: List<Long>) = JSONObject().put("n", l.size).put("meanMs", l.average() / 1e6)
            .put("minMs", (l.minOrNull() ?: 0) / 1e6).put("maxMs", (l.maxOrNull() ?: 0) / 1e6)

        val (_, single) = trial(candidates.take(1), 10)
        bench.put("single", stats(single).put("pid", Pids.hex(candidates[0])))
        var best = 1
        val multi = JSONObject()
        for (k in 2..candidates.size) {
            val (ok, lat) = trial(candidates.take(k), 4)
            multi.put(k.toString(), stats(lat).put("complete", ok).put("pidsPerSec", k / (lat.average() / 1e9)))
            if (!ok) break
            best = k
        }
        bench.put("multi", multi)
        bench.put("maxCompleteBatch", best)
        val forced = cfg.optInt("maxPidsPerRequest", 0)
        maxBatch = if (forced > 0) forced else best
        bench.put("chosenBatch", maxBatch)
        summary.put("benchmark", bench)
        val now = nanoTime()
        sink.emit("obd_bench", now, JsonLine("obd_bench").n("rx", now).raw("b", bench.toString()).build())
        status = status.copy(maxBatch = maxBatch)
    }

    private fun buildItems(): List<PollItem> {
        val fast = Config.hexList(cfg.optJSONArray("fast")).toSet()
        val medium = Config.hexList(cfg.optJSONArray("medium")).toSet()
        val slow = Config.hexList(cfg.optJSONArray("slow")).toSet()
        fun ms(k: String, d: Long) = cfg.optLong(k, d) * 1_000_000
        return supported.map { pid ->
            val (tier, interval) = when (pid) {
                in fast -> PollScheduler.FAST to ms("fastIntervalMs", 0)
                in medium -> "medium" to ms("mediumIntervalMs", 500)
                in slow -> "slow" to ms("slowIntervalMs", 5_000)
                else -> "other" to ms("otherIntervalMs", 10_000)
            }
            PollItem(pid, interval, tier, Pids.all.containsKey(pid))
        }
    }

    private fun poll(s: ElmSession) {
        setState("polling")
        val sched = PollScheduler(buildItems(), maxBatch)
        val timeoutMs = cfg.optLong("requestTimeoutMs", 2_000)
        val rvIntervalNs = cfg.optLong("adapterVoltageIntervalMs", 5_000) * 1_000_000
        val demoteAfter = cfg.optInt("demoteAfterMisses", 5)
        val demotedNs = cfg.optLong("demotedIntervalMs", 30_000) * 1_000_000
        var lastRv = nanoTime()
        var timeouts = 0
        var errors = 0
        statWindowStart = nanoTime()
        val values = HashMap<String, String>()
        var lastUi = 0L

        while (running) {
            val now = nanoTime()
            if (rvIntervalNs > 0 && now - lastRv >= rvIntervalNs) {
                lastRv = now
                val rv = s.cmd("ATRV")
                rv.lines.firstOrNull()?.let { v ->
                    status = status.copy(adapterVolts = v)
                    sink.emit("obd:adapter_v", rv.doneNs, JsonLine("obd_adapter").n("rx", rv.doneNs).s("rv", v).build())
                }
            }
            val batch = sched.next(now)
            if (batch.isEmpty()) {
                sleep(((sched.nextDueNs() - now) / 1_000_000).coerceIn(1, 50))
                continue
            }
            val pids = batch.map { it.pid }
            val r = s.cmd("01" + pids.joinToString("") { Pids.hex(it) }, timeoutMs)
            when (r.status) {
                ElmStatus.TIMEOUT -> if (++timeouts >= 3) throw ObdDisconnected("3 consecutive timeouts")
                ElmStatus.ERROR -> if (++errors >= 5) {
                    event("vehicle_lost", r.lines.joinToString(" / "))
                    return // back to discovery; car probably switched off
                }
                else -> {
                    timeouts = 0
                    errors = 0
                }
            }
            val answered = HashSet<Int>()
            for (m in ObdParser.parse(r.lines, protocol)) {
                for (v in Mode01.split(m.payload, pids)) {
                    if (v.pid !in pids) continue
                    answered += v.pid
                    emitValue(r, m.ecu, v, values)
                }
            }
            sched.completed(batch, answered, r.doneNs)
            for (it in batch) {
                if (it.consecutiveMisses == demoteAfter && it.intervalNs < demotedNs) {
                    it.intervalNs = demotedNs
                    event("pid_demoted", "${Pids.hex(it.pid)} unanswered $demoteAfter times; polling every ${demotedNs / 1_000_000_000}s")
                }
            }
            statRequests++
            statLatencyNs += r.latencyNs
            if (r.doneNs - lastUi >= 1_000_000_000L) {
                lastUi = r.doneNs
                status = status.copy(values = HashMap(values))
            }
            if (r.doneNs - statWindowStart >= 10_000_000_000L) flushStats(sched, r.doneNs, values)
        }
    }

    private fun emitValue(r: ElmResponse, ecu: String, v: PidValue, values: HashMap<String, String>) {
        pidCounts.merge(v.pid, 1L, Long::plus)
        val dataHex = v.data.joinToString("") { "%02X".format(it) }
        val def = v.def
        if (def == null) {
            sink.emit(
                "obd:pid" + Pids.hex(v.pid), r.doneNs,
                JsonLine("obd").n("tx", r.sentNs).n("rx", r.doneNs).s("ecu", ecu).s("pid", Pids.hex(v.pid)).s("data", dataHex).build(),
            )
            return
        }
        for (f in def.fields) {
            val value = runCatching { f.decode(v.data) }.getOrDefault(Double.NaN)
            sink.emit(
                "obd:" + f.name, r.doneNs,
                JsonLine("obd").n("tx", r.sentNs).n("rx", r.doneNs).s("ecu", ecu).s("pid", Pids.hex(v.pid)).s("data", dataHex)
                    .s("f", f.name).d("val", value).s("u", f.unit).build(),
            )
            values[f.name] = if (value.isFinite()) "%.4g %s".format(value, f.unit) else "–"
        }
    }

    private fun flushStats(sched: PollScheduler, now: Long, values: Map<String, String>) {
        val secs = (now - statWindowStart) / 1e9
        val rps = statRequests / secs
        val lat = if (statRequests > 0) statLatencyNs / statRequests / 1e6 else 0.0
        val perPid = JSONObject()
        for (it in sched.items) {
            perPid.put(Pids.hex(it.pid), JSONObject().put("polls", it.polls).put("answered", it.answered)
                .put("tier", it.tier).put("intervalMs", it.intervalNs / 1_000_000))
        }
        sink.emit(
            "obd_stats", now,
            JsonLine("obd_stats").n("rx", now).d("windowS", secs).n("requests", statRequests.toLong())
                .d("reqPerSec", rps).d("meanLatencyMs", lat).n("batch", sched.maxBatch).raw("pids", perPid.toString()).build(),
        )
        summary.put("lastStats", JSONObject().put("reqPerSec", rps).put("meanLatencyMs", lat).put("pids", perPid))
        status = status.copy(requestsPerSec = rps, meanLatencyMs = lat, values = HashMap(values))
        statWindowStart = now
        statRequests = 0
        statLatencyNs = 0
    }
}
