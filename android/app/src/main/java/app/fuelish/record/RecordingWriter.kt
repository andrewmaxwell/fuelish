package app.fuelish.record

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.zip.GZIPOutputStream

/** Destination for records. `tNs` is the sample time on the elapsedRealtimeNanos clock. */
fun interface RecordSink {
    fun emit(stream: String, tNs: Long, line: String) = emit(stream, tNs, line, null)
    fun emit(stream: String, tNs: Long, line: String, track: DoubleArray?)
}

class Rec(val stream: String, val tNs: Long, val line: String, val track: DoubleArray?)

/**
 * Per-second means of the engine values the OBD recorder marks for the summary, so the web
 * page can chart them without downloading raw chunks (~2 MB a minute). Raw values stay in the chunk.
 *
 * Status values (check-engine light, code count, fuel system status) keep the last reading of the
 * second instead of a mean, since an average of states means nothing.
 *
 * Fuel flow is estimated here, per airflow sample, from the commanded air-fuel ratio read within the
 * last [LAMBDA_MAX_AGE_MS] (`fuel_est_gs`, g/s, 0 during fuel cut), and `fuel_cut` is the share of
 * those samples in fuel cut. Averaging airflow and lambda first and dividing afterwards overstates
 * fuel in any second that mixes fueling and fuel cut. Derivation version: [FUEL_EST_VERSION].
 */
class EngineSummary {
    private val cols = LinkedHashMap<String, Int>()
    private val bins = java.util.TreeMap<Long, HashMap<Int, DoubleArray>>() // second -> col -> [sum, n, last]
    private var lambda = Double.NaN
    private var lambdaMs = Long.MIN_VALUE

    fun add(field: String, wallMs: Long, value: Double) {
        if (!value.isFinite()) return
        put(field, wallMs, value)
        when (field) {
            "commanded_lambda" -> {
                lambda = value
                lambdaMs = wallMs
            }
            "maf" -> if (lambda > 0 && wallMs - lambdaMs in 0..LAMBDA_MAX_AGE_MS) {
                val cut = lambda >= 1.99
                put("fuel_est_gs", wallMs, if (cut) 0.0 else value / (AFR * lambda))
                put("fuel_cut", wallMs, if (cut) 1.0 else 0.0)
            }
        }
    }

    private fun put(field: String, wallMs: Long, value: Double) {
        val c = cols.getOrPut(field) { cols.size }
        val acc = bins.getOrPut(Math.floorDiv(wallMs, 1000L)) { HashMap() }.getOrPut(c) { DoubleArray(3) }
        acc[0] += value
        acc[1] += 1.0
        acc[2] = value
    }

    val isEmpty get() = bins.isEmpty()

    /** An empty summary for the next chunk that still knows the latest air-fuel target. */
    fun next() = EngineSummary().also {
        it.lambda = lambda
        it.lambdaMs = lambdaMs
    }

    fun columns() = JSONArray(cols.keys.toList())

    /** Rows of [wallMs at the middle of the second, value per column (null if none that second)]. */
    fun rows() = JSONArray().apply {
        val names = cols.keys.toList()
        for ((sec, byCol) in bins) {
            put(JSONArray().apply {
                put(sec * 1000 + 500)
                for (c in 0 until cols.size) {
                    val acc = byCol[c]
                    val v = when {
                        acc == null -> null
                        names[c] in LAST_FIELDS -> acc[2]
                        else -> acc[0] / acc[1]
                    }
                    put(if (v == null) JSONObject.NULL else Math.round(v * 1000) / 1000.0)
                }
            })
        }
    }

    companion object {
        const val AFR = 14.08 // stoichiometric air-fuel ratio of E10 pump gas
        const val LAMBDA_MAX_AGE_MS = 1000L
        const val FUEL_EST_VERSION = 1
        val LAST_FIELDS = setOf("mil_on", "dtc_count", "fuel_sys1")
    }
}

/** Per-stream interval statistics for one chunk; `t` values are sample timestamps. */
class StreamStat {
    var n = 0L
    var firstNs = 0L
    var lastNs = 0L
    var minDtNs = Long.MAX_VALUE
    var maxDtNs = 0L
    var longGaps = 0L

    fun add(t: Long) {
        if (n > 0) {
            val dt = t - lastNs
            if (dt < minDtNs) minDtNs = dt
            if (dt > maxDtNs) maxDtNs = dt
            if (dt > 1_000_000_000L) longGaps++
        } else firstNs = t
        lastNs = t
        n++
    }

    fun toJson() = JSONObject().apply {
        put("n", n)
        put("firstNs", firstNs)
        put("lastNs", lastNs)
        if (n > 1) {
            put("minDtNs", minDtNs)
            put("maxDtNs", maxDtNs)
        }
        put("longGaps", longGaps)
    }
}

data class ChunkInfo(val seq: Int, val gzFile: File, val metaFile: File, val meta: JSONObject)

/**
 * Single writer thread. Producers call [emit] from any thread; it never blocks — if the
 * queue is full the record is counted as dropped and a `drop` record is written later.
 *
 * Each chunk is written as plain NDJSON (`chunk-NNNNNN.ndjson`, flushed every second so
 * a crash loses at most ~1 s), then gzipped to `.ndjson.gz` with a `.meta.json` sidecar
 * when it rotates. The `.gz` + meta pair is immutable and is what gets uploaded.
 */
class RecordingWriter(
    private val dir: File,
    private val recordingId: String,
    private val chunkSeconds: Int,
    private val chunkMaxBytes: Long,
    private val elapsedNs: () -> Long,
    private val wallMs: () -> Long,
    private val onChunkClosed: (ChunkInfo) -> Unit,
    queueCapacity: Int = 100_000,
) : RecordSink {
    private val queue = ArrayBlockingQueue<Rec>(queueCapacity)
    private val thread = Thread(::run, "fuelish-writer")
    @Volatile private var stopping = false

    val dropped = AtomicLong()
    val written = AtomicLong()
    val rawBytesTotal = AtomicLong()
    val gzBytesTotal = AtomicLong()
    @Volatile var chunksClosed = 0
        private set
    @Volatile var error: Throwable? = null
        private set

    private var seq = 0
    private var out: BufferedOutputStream? = null
    private var fos: FileOutputStream? = null
    private var chunkRaw: File? = null
    private var chunkStartNs = 0L
    private var chunkStartWall = 0L
    private var chunkBytes = 0L
    private var chunkRecords = 0L
    private var chunkDrops = 0L
    private var reportedDrops = 0L
    private var stats = HashMap<String, StreamStat>()
    private var track = JSONArray()
    private var engine = EngineSummary()

    fun start() {
        dir.mkdirs()
        thread.start()
    }

    override fun emit(stream: String, tNs: Long, line: String, track: DoubleArray?) {
        if (!queue.offer(Rec(stream, tNs, line, track))) dropped.incrementAndGet()
    }

    /** Drains the queue, closes the final chunk, and returns the number of chunks written. */
    fun stop(): Int {
        stopping = true
        thread.join()
        return chunksClosed
    }

    val queueSize get() = queue.size

    private fun run() {
        try {
            openChunk()
            var lastFlush = System.nanoTime()
            while (true) {
                val r = queue.poll(250, TimeUnit.MILLISECONDS)
                if (r != null) write(r)
                val d = dropped.get()
                if (d != reportedDrops) {
                    val now = elapsedNs()
                    chunkDrops += d - reportedDrops
                    write(Rec("drop", now, JsonLine("drop").n("rx", now).n("total", d).build(), null))
                    reportedDrops = d
                }
                if (r == null && stopping && queue.isEmpty()) break
                val nowNano = System.nanoTime()
                if (nowNano - lastFlush > 1_000_000_000L) {
                    out?.flush()
                    lastFlush = nowNano
                }
                if (elapsedNs() - chunkStartNs >= chunkSeconds * 1_000_000_000L || chunkBytes >= chunkMaxBytes) {
                    closeChunk()
                    openChunk()
                }
            }
            closeChunk()
        } catch (t: Throwable) {
            error = t
            runCatching { out?.close() }
        }
    }

    private fun write(r: Rec) {
        val bytes = r.line.toByteArray(Charsets.UTF_8)
        out!!.write(bytes)
        out!!.write('\n'.code)
        chunkBytes += bytes.size + 1
        chunkRecords++
        written.incrementAndGet()
        stats.getOrPut(r.stream) { StreamStat() }.add(r.tNs)
        // Every GPS fix goes into the chunk's track summary so the web map can draw the
        // route without downloading raw data. Point layout: see TRACK_FORMAT.
        // OBD values marked for the engine summary carry their value the same way.
        r.track?.let { t ->
            if (r.stream.startsWith("obd:")) engine.add(r.stream.removePrefix("obd:"), chunkStartWall + (r.tNs - chunkStartNs) / 1_000_000, t[0])
            else track.put(JSONArray().apply { t.forEach { put(if (it.isFinite()) it else JSONObject.NULL) } })
        }
    }

    private fun openChunk() {
        chunkStartNs = elapsedNs()
        chunkStartWall = wallMs()
        val f = File(dir, chunkName(seq, ".ndjson"))
        chunkRaw = f
        fos = FileOutputStream(f)
        out = BufferedOutputStream(fos, 64 * 1024)
        chunkBytes = 0
        chunkRecords = 0
        chunkDrops = 0
        stats = HashMap()
        track = JSONArray()
        engine = engine.next()
        write(
            Rec(
                "chunk", chunkStartNs,
                JsonLine("chunk").n("v", FORMAT_VERSION).s("rec", recordingId).n("seq", seq)
                    .n("rx", chunkStartNs).n("wall", chunkStartWall).build(),
                null,
            ),
        )
    }

    private fun closeChunk() {
        val o = out ?: return
        o.flush()
        fos!!.fd.sync()
        o.close()
        out = null
        val meta = JSONObject().apply {
            put("seq", seq)
            put("records", chunkRecords)
            put("firstNs", chunkStartNs)
            put("lastNs", elapsedNs())
            put("wallStartMs", chunkStartWall)
            put("wallEndMs", wallMs())
            put("drops", chunkDrops)
            put("streams", JSONObject().apply { stats.forEach { (k, s) -> put(k, s.toJson()) } })
            put("trackFormat", TRACK_FORMAT)
            put("track", track)
            if (!engine.isEmpty) {
                put("engineFormat", ENGINE_FORMAT)
                put("fuelEstVersion", EngineSummary.FUEL_EST_VERSION)
                put("engineCols", engine.columns())
                put("engine", engine.rows())
            }
        }
        val info = finalizeChunk(dir, seq, chunkRaw!!, meta)
        rawBytesTotal.addAndGet(meta.getLong("rawBytes"))
        gzBytesTotal.addAndGet(meta.getLong("gzBytes"))
        seq++
        chunksClosed = seq
        onChunkClosed(info)
    }

    companion object {
        const val FORMAT_VERSION = 1

        /**
         * 2 = every GPS fix as [wallMs, lat, lon, speedMps, hAccM, bearingDeg, joltMps2, pressureHpa];
         * null = unknown. pressureHpa (the barometer's mean since the previous fix) was added later:
         * older chunks stop at joltMps2.
         */
        const val TRACK_FORMAT = 2

        /**
         * 1 = `engine` rows of [wallMs, mean of each `engineCols` field over that second (or null)].
         * Status fields hold the second's last value; see [EngineSummary].
         */
        const val ENGINE_FORMAT = 1

        fun chunkName(seq: Int, ext: String) = "chunk-%06d%s".format(seq, ext)

        /**
         * Gzips a raw chunk, writes its sidecar meta (adding size and sha256), then deletes
         * the raw file. Safe to re-run after a crash: a leftover raw file simply gets redone.
         */
        fun finalizeChunk(dir: File, seq: Int, raw: File, meta: JSONObject): ChunkInfo {
            val gz = File(dir, chunkName(seq, ".ndjson.gz"))
            val tmp = File(dir, chunkName(seq, ".ndjson.gz.tmp"))
            val sha = MessageDigest.getInstance("SHA-256")
            FileOutputStream(tmp).use { fos ->
                val digesting = object : java.io.FilterOutputStream(fos) {
                    override fun write(b: Int) {
                        sha.update(b.toByte()); out.write(b)
                    }
                    override fun write(b: ByteArray, off: Int, len: Int) {
                        sha.update(b, off, len); out.write(b, off, len)
                    }
                }
                val gzo = GZIPOutputStream(digesting, 64 * 1024)
                raw.inputStream().use { it.copyTo(gzo, 64 * 1024) }
                gzo.finish()
                gzo.flush()
                fos.fd.sync()
            }
            meta.put("rawBytes", raw.length())
            meta.put("gzBytes", tmp.length())
            meta.put("sha256", sha.digest().joinToString("") { "%02x".format(it) })
            val metaFile = File(dir, chunkName(seq, ".meta.json"))
            writeAtomically(metaFile, meta.toString())
            check(tmp.renameTo(gz)) { "rename failed for $gz" }
            raw.delete()
            return ChunkInfo(seq, gz, metaFile, meta)
        }

        fun writeAtomically(f: File, text: String) {
            val tmp = File(f.parentFile, f.name + ".tmp")
            FileOutputStream(tmp).use {
                it.write(text.toByteArray())
                it.fd.sync()
            }
            check(tmp.renameTo(f)) { "rename failed for $f" }
        }
    }
}
