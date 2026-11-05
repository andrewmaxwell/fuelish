package app.fuelish.record

import org.json.JSONArray
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
 *   recordings/<id>/upload.target              where it uploads: server and account (see [UploadTarget])
 *   recordings/<id>/upload.refused             the server refused it (someone else's trip): the reason
 *   recordings/<id>/resumed                    marker: cut short by an app update, a new recording carried on
 *
 * The acknowledgement files above belong to the server in upload.target.
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
    fun markServerComplete(id: String) {
        File(dir(id), SERVER_COMPLETE).writeText("")
        File(dir(id), SERVER_MISSING).delete()
    }

    /** Chunks the server said it lacks that the phone can no longer send (its copy was deleted). */
    fun serverMissing(id: String): List<Int> =
        File(dir(id), SERVER_MISSING).takeIf { it.exists() }?.readText()?.split(',')?.mapNotNull { it.trim().toIntOrNull() } ?: emptyList()
    fun markServerMissing(id: String, seqs: List<Int>) {
        if (seqs.isEmpty()) File(dir(id), SERVER_MISSING).delete() else File(dir(id), SERVER_MISSING).writeText(seqs.joinToString(","))
    }

    /**
     * Forgets the upload acknowledgement of a chunk the server turned out not to have, so it's sent
     * again. Only possible while the phone still has its data; returns whether it did.
     */
    fun resend(id: String, seq: Int): Boolean {
        if (!chunkFile(id, seq).exists()) return false
        File(dir(id), RecordingWriter.chunkName(seq, ".uploaded")).delete()
        return true
    }

    /** Finished recordings (not [activeId]) the server hasn't yet confirmed it holds in full. */
    fun unconfirmed(activeId: String?): List<String> =
        ids().filter { it != activeId && runCatching { readMeta(it).optString("status") != "recording" && !serverComplete(it) }.getOrDefault(false) }

    /** Recordings with parts missing on the server and gone from the phone: these need a person. */
    fun needsAttention(): Map<String, List<Int>> = ids().associateWith { serverMissing(it) }.filterValues { it.isNotEmpty() }

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

    fun target(id: String): UploadTarget? =
        File(dir(id), TARGET).takeIf { it.exists() }?.let { f -> runCatching { UploadTarget.fromJson(JSONObject(f.readText())) }.getOrNull() }

    fun setTarget(id: String, t: UploadTarget) {
        dir(id).mkdirs()
        RecordingWriter.writeAtomically(File(dir(id), TARGET), t.toJson().toString())
    }

    /** Why the server refused this recording from the upload key [key]; null if it didn't (or a different key tried). */
    fun refusal(id: String, key: String): String? =
        File(dir(id), REFUSED).takeIf { it.exists() }?.readText()?.split('\n', limit = 2)?.takeIf { it.size == 2 && it[0] == key }?.get(1)
    fun markRefused(id: String, key: String, why: String) = File(dir(id), REFUSED).writeText("$key\n$why")

    /**
     * Sends a recording to [t] from now on (the person chose to upload it as the account signed in
     * now). Moving to another server forgets what the old one acknowledged, so every part still on the
     * phone goes to the new one; parts already deleted after reaching the old server stay there.
     */
    fun retarget(id: String, t: UploadTarget) {
        val old = target(id)
        if (old != null && old.server != t.server) {
            File(dir(id), META_UPLOADED).delete()
            File(dir(id), SERVER_COMPLETE).delete()
            File(dir(id), SERVER_MISSING).delete()
            for (seq in finishedChunks(id)) if (chunkFile(id, seq).exists()) File(dir(id), RecordingWriter.chunkName(seq, ".uploaded")).delete()
        }
        File(dir(id), REFUSED).delete()
        setTarget(id, t)
    }

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
     * The recording an app restart (an update replacing the app) just cut short, to carry on: the
     * newest one, still "recording" or already recovered as "interrupted", last written within
     * [withinMs] of [nowMs] and not resumed before. Claims it (a marker file), so it's resumed once.
     */
    fun claimCutShort(nowMs: Long, withinMs: Long): Pair<String, JSONObject>? {
        val id = ids().lastOrNull() ?: return null
        val meta = runCatching { readMeta(id) }.getOrNull() ?: return null
        val d = dir(id)
        val lastWriteMs = when (meta.optString("status")) {
            // Recovery sets endedWallMs to the last write before the kill (its own writes are newer).
            "interrupted" -> meta.optLong("endedWallMs")
            "recording" -> d.listFiles()?.maxOfOrNull { it.lastModified() } ?: 0L
            else -> return null
        }
        if (nowMs - lastWriteMs !in 0..withinMs) return null
        val marker = File(d, RESUMED)
        if (!marker.createNewFile()) return null
        return id to meta
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
     * Sidecar for a recovered chunk. It has no full route or engine summary (the web page rebuilds
     * those from the raw data), only a thinned `routeOutline` for the trip list, but it does carry the clock mapping that rebuild needs and which
     * kinds of data are inside, from the chunk's own header record and timestamps.
     */
    private fun recoveredMeta(seq: Int, f: File): JSONObject {
        var lines = 0L
        var firstNs = 0L
        var wallStartMs = 0L
        var lastNs = 0L
        val kinds = HashMap<String, Long>()
        val gps = JSONArray() // for the list's route; see RouteOutline
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
                if (stream == "loc:gps" && o.has("lat") && o.has("lon") && o.has("time")) {
                    gps.put(JSONArray().put(o.getLong("time")).put(o.getDouble("lat")).put(o.getDouble("lon"))
                        .put(if (o.has("speed")) o.getDouble("speed") else JSONObject.NULL)
                        .put(if (o.has("hAcc")) o.getDouble("hAcc") else JSONObject.NULL))
                }
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
            app.fuelish.upload.RouteOutline.fit(gps, 30_000)?.let { put("routeOutline", it) }
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
        const val SERVER_MISSING = "server.missing"
        const val TARGET = "upload.target"
        const val REFUSED = "upload.refused"
        const val RESUMED = "resumed"
        private val CHUNK_META = Regex("""chunk-(\d{6})\.meta\.json""")
        private val RAW_CHUNK = Regex("""chunk-(\d{6})\.ndjson""")

        fun newId(wallMs: Long, random: java.util.Random = java.util.Random()): String {
            val fmt = SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            return fmt.format(Date(wallMs)) + "-" + "%04x".format(random.nextInt(0x10000))
        }

        fun sha256(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    }
}

/**
 * Where a recording uploads: [server] (normalized URL), [key] (a short fingerprint of the upload
 * token, never the token) and [account] (the server's id for the person, when the phone knows it).
 * Fixed when the recording starts, so signing in as someone else later doesn't hand it to them.
 */
data class UploadTarget(val server: String, val key: String, val account: String?, val accountName: String? = null) {
    /** Same destination: same server, and the same person (by account when both know it, else by key). */
    fun sameAs(o: UploadTarget): Boolean =
        server == o.server && (if (account != null && o.account != null) account == o.account else key == o.key)

    fun toJson(): JSONObject = JSONObject().put("server", server).put("key", key)
        .put("account", account ?: JSONObject.NULL).put("accountName", accountName ?: JSONObject.NULL)

    companion object {
        fun of(serverUrl: String, token: String, account: String? = null, accountName: String? = null) = UploadTarget(
            serverUrl.trim().trimEnd('/').lowercase(),
            if (token.isBlank()) "" else RecordingStore.sha256(token.toByteArray()).take(16),
            account, accountName,
        )

        fun fromJson(o: JSONObject) = UploadTarget(
            o.getString("server"), o.getString("key"),
            o.optString("account").takeIf { !o.isNull("account") && it.isNotEmpty() },
            o.optString("accountName").takeIf { !o.isNull("accountName") && it.isNotEmpty() },
        )
    }
}
