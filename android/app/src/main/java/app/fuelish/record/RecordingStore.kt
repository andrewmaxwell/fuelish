package app.fuelish.record

import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * On-disk layout (one directory per recording):
 *
 *   recordings/<id>/recording.json            metadata, rewritten atomically
 *   recordings/<id>/chunk-000000.ndjson        chunk being written (or left by a crash)
 *   recordings/<id>/chunk-000000.ndjson.gz     finished chunk (immutable; deleted once uploaded if
 *                                              deleteAfterUpload is on)
 *   recordings/<id>/chunk-000000.meta.json     stats + sha256 for the finished chunk
 *   recordings/<id>/chunk-000000.uploaded      marker: server acknowledged this chunk
 *   recordings/<id>/meta.uploaded              sha256 of the last recording.json the server accepted
 *   recordings/<id>/server.complete            marker: the server confirmed it holds every chunk 0..chunkCount-1
 *
 * recording.json carries `rev`, raised on every write, so the server can ignore a stale copy that
 * arrives after a newer one.
 */
class RecordingStore(val root: File) {
    init {
        root.mkdirs()
    }

    fun dir(id: String) = File(root, id)

    fun ids(): List<String> =
        root.listFiles()?.filter { File(it, META).exists() }?.map { it.name }?.sorted() ?: emptyList()

    fun readMeta(id: String): JSONObject = JSONObject(File(dir(id), META).readText())

    fun writeMeta(id: String, meta: JSONObject) {
        dir(id).mkdirs()
        // Never lower the revision, even if the caller's copy is older than the file.
        val onDisk = runCatching { readMeta(id).optLong("rev", 0) }.getOrDefault(0L)
        meta.put("rev", maxOf(onDisk, meta.optLong("rev", 0)) + 1)
        RecordingWriter.writeAtomically(File(dir(id), META), meta.toString())
    }

    /** Finished chunks whose upload has not been acknowledged, in order. */
    fun pendingChunks(id: String): List<Int> =
        finishedChunks(id).filter { !File(dir(id), RecordingWriter.chunkName(it, ".uploaded")).exists() }

    /** Every finished chunk, whether its data is still on the phone or already uploaded and deleted. */
    fun finishedChunks(id: String): List<Int> =
        dir(id).listFiles()?.mapNotNull { CHUNK_META.matchEntire(it.name)?.groupValues?.get(1)?.toInt() }
            ?.filter { chunkFile(id, it).exists() || File(dir(id), RecordingWriter.chunkName(it, ".uploaded")).exists() }
            ?.sorted() ?: emptyList()

    fun chunkFile(id: String, seq: Int) = File(dir(id), RecordingWriter.chunkName(seq, ".ndjson.gz"))
    fun chunkMeta(id: String, seq: Int) = JSONObject(File(dir(id), RecordingWriter.chunkName(seq, ".meta.json")).readText())

    /** Call only after the server acknowledged the chunk. The marker is written before the data is deleted. */
    fun markChunkUploaded(id: String, seq: Int, deleteData: Boolean = false) {
        File(dir(id), RecordingWriter.chunkName(seq, ".uploaded")).writeText("")
        if (deleteData) chunkFile(id, seq).delete()
    }

    fun metaHash(id: String): String = sha256(File(dir(id), META).readBytes())
    fun uploadedMetaHash(id: String): String? = File(dir(id), META_UPLOADED).takeIf { it.exists() }?.readText()
    fun markMetaUploaded(id: String, hash: String) = File(dir(id), META_UPLOADED).writeText(hash)

    fun serverComplete(id: String) = File(dir(id), SERVER_COMPLETE).exists()
    fun markServerComplete(id: String) = File(dir(id), SERVER_COMPLETE).writeText("")

    /** Raw chunks still being written or left unfinished (by a crash or a writer error), and temp files. */
    fun unfinishedFiles(id: String): List<File> =
        dir(id).listFiles()?.filter { RAW_CHUNK.matches(it.name) || it.name.endsWith(".tmp") } ?: emptyList()

    /**
     * True when the local copy of a finished recording may be deleted: its final chunk count is
     * known, every chunk 0 until that count is finished and acknowledged, nothing is left
     * half-written, the server has the latest metadata, and the server itself confirmed that it
     * holds every chunk.
     */
    fun fullyUploaded(id: String): Boolean {
        val meta = readMeta(id)
        if (meta.optString("status") == "recording" || !meta.has("chunkCount")) return false
        val n = meta.optInt("chunkCount", -1)
        return n >= 0 && finishedChunks(id) == (0 until n).toList() && pendingChunks(id).isEmpty() &&
            unfinishedFiles(id).isEmpty() && uploadedMetaHash(id) == metaHash(id) && serverComplete(id)
    }

    fun pendingChunkCount(): Int = ids().sumOf { pendingChunks(it).size }

    fun bytesUsed(): Long = root.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    /**
     * Finishes recordings left in "recording" state by a crash or kill: gzips leftover raw
     * chunks and marks the recording "interrupted" with its final chunk count. Call only
     * when [activeId] is the sole recording that may legitimately still be open; it is
     * re-read per recording because a new recording may start while this runs.
     */
    fun recover(activeId: () -> String?): List<String> {
        val recovered = mutableListOf<String>()
        for (id in ids()) {
            if (id == activeId()) continue
            val meta = runCatching { readMeta(id) }.getOrNull() ?: continue
            val d = dir(id)
            val lastModified = finalizeLeftovers(id)
            if (meta.optString("status") == "recording") {
                val chunks = finishedChunks(id)
                meta.put("status", "interrupted")
                meta.put("chunkCount", if (chunks.isEmpty()) 0 else chunks.last() + 1)
                // Last write before the crash: the leftover raw chunk's mtime if there was one,
                // otherwise the last finished chunk (not a file we just created while recovering).
                val lastChunkMs = if (lastModified > 0) 0L else
                    chunks.lastOrNull()?.let { File(d, RecordingWriter.chunkName(it, ".meta.json")).lastModified() } ?: 0L
                meta.put("endedWallMs", maxOf(lastModified, lastChunkMs, meta.optLong("startedWallMs")))
                writeMeta(id, meta)
                recovered += id
            }
        }
        return recovered
    }

    /**
     * Gzips raw chunks left unfinished (by a crash, or by the writer failing mid-chunk) so their data
     * gets uploaded like any other chunk, and removes temp files. Returns the newest leftover's
     * modification time, or 0 when there was none.
     */
    fun finalizeLeftovers(id: String): Long {
        val d = dir(id)
        var lastModified = 0L
        d.listFiles()?.sortedBy { it.name }?.forEach { f ->
            val m = RAW_CHUNK.matchEntire(f.name) ?: return@forEach
            val seq = m.groupValues[1].toInt()
            lastModified = maxOf(lastModified, f.lastModified())
            if (chunkFile(id, seq).exists() && File(d, RecordingWriter.chunkName(seq, ".meta.json")).exists()) {
                f.delete() // crashed after gzip but before deleting the raw file
            } else if (f.length() == 0L) {
                f.delete()
            } else {
                RecordingWriter.finalizeChunk(d, seq, f, recoveredMeta(seq, f))
            }
        }
        d.listFiles()?.filter { it.name.endsWith(".tmp") }?.forEach { it.delete() }
        return lastModified
    }

    /**
     * Sidecar for a recovered chunk. It has no route or engine summary (the web page rebuilds
     * those from the raw data), but it does carry the clock mapping that rebuild needs and which
     * kinds of data are inside, from the chunk's own header record and timestamps.
     */
    private fun recoveredMeta(seq: Int, f: File): JSONObject {
        var lines = 0L
        var firstNs = 0L
        var wallStartMs = 0L
        var lastNs = 0L
        val kinds = HashMap<String, Long>()
        f.useLines { seqLines ->
            for (line in seqLines) {
                lines++
                val o = runCatching { JSONObject(line) }.getOrNull() ?: continue // a torn last line
                val k = o.optString("k")
                if (k == "chunk" && firstNs == 0L) {
                    firstNs = o.optLong("rx")
                    wallStartMs = o.optLong("wall")
                }
                val rx = o.optLong("rx", 0L).takeIf { it > 0 } ?: o.optLong("et", 0L)
                if (rx > lastNs) lastNs = rx
                val stream = when (k) {
                    "obd" -> o.optString("f").takeIf { it.isNotEmpty() }?.let { "obd:$it" } ?: "obd:pid" + o.optString("pid")
                    "loc" -> "loc:" + o.optString("p")
                    else -> k
                }
                kinds.merge(stream, 1L, Long::plus)
            }
        }
        return JSONObject().put("seq", seq).put("records", lines).put("recovered", true).apply {
            if (firstNs > 0) {
                put("firstNs", firstNs)
                put("wallStartMs", wallStartMs)
                put("lastNs", lastNs)
                put("wallEndMs", wallStartMs + (lastNs - firstNs) / 1_000_000)
            }
            put("streams", JSONObject().apply { kinds.forEach { (k, n) -> put(k, JSONObject().put("n", n)) } })
        }
    }

    /** Deletes local copies of recordings the server has fully acknowledged. */
    fun deleteUploaded(activeId: String?): Int {
        var n = 0
        for (id in ids()) {
            if (id != activeId && fullyUploaded(id)) {
                dir(id).deleteRecursively()
                n++
            }
        }
        return n
    }

    companion object {
        const val META = "recording.json"
        const val META_UPLOADED = "meta.uploaded"
        const val SERVER_COMPLETE = "server.complete"
        private val CHUNK_META = Regex("""chunk-(\d{6})\.meta\.json""")
        private val RAW_CHUNK = Regex("""chunk-(\d{6})\.ndjson""")

        fun newId(wallMs: Long, random: java.util.Random = java.util.Random()): String {
            val fmt = SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            return fmt.format(Date(wallMs)) + "-" + "%04x".format(random.nextInt(0x10000))
        }

        fun sha256(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    }
}
