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
 *   recordings/<id>/chunk-000000.ndjson.gz     finished chunk (immutable)
 *   recordings/<id>/chunk-000000.meta.json     stats + sha256 for the finished chunk
 *   recordings/<id>/chunk-000000.uploaded      marker: server acknowledged this chunk
 *   recordings/<id>/meta.uploaded              sha256 of the last recording.json the server accepted
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
        RecordingWriter.writeAtomically(File(dir(id), META), meta.toString())
    }

    /** Finished chunks whose upload has not been acknowledged, in order. */
    fun pendingChunks(id: String): List<Int> =
        finishedChunks(id).filter { !File(dir(id), RecordingWriter.chunkName(it, ".uploaded")).exists() }

    fun finishedChunks(id: String): List<Int> =
        dir(id).listFiles()?.mapNotNull { CHUNK_META.matchEntire(it.name)?.groupValues?.get(1)?.toInt() }
            ?.filter { File(dir(id), RecordingWriter.chunkName(it, ".ndjson.gz")).exists() }
            ?.sorted() ?: emptyList()

    fun chunkFile(id: String, seq: Int) = File(dir(id), RecordingWriter.chunkName(seq, ".ndjson.gz"))
    fun chunkMeta(id: String, seq: Int) = JSONObject(File(dir(id), RecordingWriter.chunkName(seq, ".meta.json")).readText())

    fun markChunkUploaded(id: String, seq: Int) {
        File(dir(id), RecordingWriter.chunkName(seq, ".uploaded")).writeText("")
    }

    fun metaHash(id: String): String = sha256(File(dir(id), META).readBytes())
    fun uploadedMetaHash(id: String): String? = File(dir(id), META_UPLOADED).takeIf { it.exists() }?.readText()
    fun markMetaUploaded(id: String, hash: String) = File(dir(id), META_UPLOADED).writeText(hash)

    /** True when everything for a finished recording has been acknowledged by the server. */
    fun fullyUploaded(id: String): Boolean {
        val meta = readMeta(id)
        return meta.optString("status") != "recording" && pendingChunks(id).isEmpty() &&
            uploadedMetaHash(id) == metaHash(id)
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
            var lastModified = 0L
            d.listFiles()?.forEach { f ->
                val m = RAW_CHUNK.matchEntire(f.name) ?: return@forEach
                val seq = m.groupValues[1].toInt()
                lastModified = maxOf(lastModified, f.lastModified())
                if (chunkFile(id, seq).exists() && File(d, RecordingWriter.chunkName(seq, ".meta.json")).exists()) {
                    f.delete() // crashed after gzip but before deleting the raw file
                } else if (f.length() == 0L) {
                    f.delete()
                } else {
                    val lines = f.useLines { it.count() }
                    RecordingWriter.finalizeChunk(
                        d, seq, f,
                        JSONObject().put("seq", seq).put("records", lines).put("recovered", true),
                    )
                }
            }
            d.listFiles()?.filter { it.name.endsWith(".tmp") }?.forEach { it.delete() }
            if (meta.optString("status") == "recording") {
                val chunks = finishedChunks(id)
                meta.put("status", "interrupted")
                meta.put("chunkCount", if (chunks.isEmpty()) 0 else chunks.last() + 1)
                // Last write before the crash: the leftover raw chunk's mtime if there was one,
                // otherwise the last finished chunk (not a file we just created while recovering).
                val lastChunkMs = if (lastModified > 0) 0L else chunks.lastOrNull()?.let { chunkFile(id, it).lastModified() } ?: 0L
                meta.put("endedWallMs", maxOf(lastModified, lastChunkMs, meta.optLong("startedWallMs")))
                writeMeta(id, meta)
                recovered += id
            }
        }
        return recovered
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
        private val CHUNK_META = Regex("""chunk-(\d{6})\.meta\.json""")
        private val RAW_CHUNK = Regex("""chunk-(\d{6})\.ndjson""")

        fun newId(wallMs: Long, random: java.util.Random = java.util.Random()): String {
            val fmt = SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            return fmt.format(Date(wallMs)) + "-" + "%04x".format(random.nextInt(0x10000))
        }

        fun sha256(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    }
}
