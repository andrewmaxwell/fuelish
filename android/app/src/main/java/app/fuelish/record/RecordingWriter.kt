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
    private var lastTrackNs = Long.MIN_VALUE / 2

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
        val t = r.track
        // Track preview for the web map: at most one point every 5 s.
        if (t != null && r.tNs - lastTrackNs >= 5_000_000_000L) {
            lastTrackNs = r.tNs
            track.put(JSONArray().apply { t.forEach { put(it) } })
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
            put("track", track)
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
