package app.fuelish.upload

import app.fuelish.record.RecordingStore
import app.fuelish.record.UploadTarget
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

private val CONFLICT = UploadResult.Retry("conflict", 0)
private val REFUSED = UploadResult.Retry("refused", 0)

sealed class UploadResult {
    data class Done(val chunks: Int) : UploadResult()
    /** Everything sendable was sent, but the server lacks chunks the phone no longer has: id -> seqs. */
    data class Incomplete(val chunks: Int, val missing: Map<String, List<Int>>) : UploadResult()
    /** Bad token or URL: retrying will not help until settings change. */
    data class Fatal(val message: String) : UploadResult()
    /** Network or server trouble: retry later with backoff. */
    data class Retry(val message: String, val chunks: Int) : UploadResult()
}

/**
 * Pushes finished chunks to the API. Idempotent end to end: the server keys chunks by
 * (recording, seq) and verifies sha256, a retry of an acknowledged chunk is answered
 * "duplicate", and a chunk is only marked uploaded locally after the server says so.
 */
class Uploader(
    private val store: RecordingStore,
    private val baseUrl: String,
    private val token: String,
    /** Delete each chunk once the server has it, and the whole recording once it is complete there. */
    private val deleteAfterUpload: Boolean = false,
    /** Checked between requests: true once the job was cancelled, so it stops at the next safe point. */
    private val cancelled: () -> Boolean = { false },
    /** Called once per recording when the server confirms it has all of it (before any local delete). */
    private val onServerComplete: (id: String) -> Unit = {},
) {
    class Response(val code: Int, val body: String)

    /** After a run: where uploads go now (the account the server says the key belongs to, if it said). */
    var current: UploadTarget? = null
        private set
    /** After a run: recordings left waiting because they belong to another account or server, or were refused. */
    val held = mutableListOf<String>()

    private fun UploadResult.withChunks(n: Int) = if (this is UploadResult.Retry) copy(chunks = n) else this

    /**
     * Uploads everything pending. Only one upload runs at a time in the whole app (the periodic job,
     * an immediate one and a manual one can all be started at once): a second caller waits for the
     * first to finish, then finds little or nothing left to do.
     */
    fun uploadAll(): UploadResult = LOCK.withLock { uploadAllLocked() }

    private fun uploadAllLocked(): UploadResult {
        if (baseUrl.isBlank() || token.isBlank()) return UploadResult.Fatal("server URL or device token not set")
        var uploaded = 0
        val conflicts = mutableListOf<String>()
        val stopped = UploadResult.Retry("cancelled", 0)
        held.clear()
        try {
            val now = whoAmI().let { it as? UploadTarget ?: return it as UploadResult }
            current = now
            for (id in store.ids()) {
                if (cancelled()) return stopped.withChunks(uploaded)
                // Safe on the server it went to, whichever that was.
                if (store.fullyUploaded(id)) {
                    if (deleteAfterUpload) store.dir(id).deleteRecursively()
                    continue
                }
                if (!mayUpload(id, now)) {
                    held += id
                    continue
                }
                fun refused(r: UploadResult?): Boolean {
                    if (r !== REFUSED) return false
                    held += id
                    return true
                }
                val m1 = putMetaIfChanged(id)
                if (refused(m1)) continue
                m1?.let { return it.withChunks(uploaded) }
                var skip = false
                for (seq in store.pendingChunks(id)) {
                    if (cancelled()) return stopped.withChunks(uploaded)
                    when (val r = putChunk(id, seq)) {
                        null -> uploaded++
                        CONFLICT -> conflicts += "$id/$seq"
                        REFUSED -> { held += id; skip = true }
                        else -> return r.withChunks(uploaded)
                    }
                    if (skip) break
                }
                if (skip) continue
                val m2 = putMetaIfChanged(id)
                if (refused(m2)) continue
                m2?.let { return it.withChunks(uploaded) }
                verifyIfFinished(id)?.let { return it.withChunks(uploaded) }
                if (deleteAfterUpload && store.fullyUploaded(id)) store.dir(id).deleteRecursively()
            }
        } catch (e: IOException) {
            return UploadResult.Retry(e.toString(), uploaded)
        }
        // A conflict means the server holds different bytes for that seq. Never overwrite;
        // keep the local copy and keep reporting it, without blocking other chunks.
        if (conflicts.isNotEmpty()) return UploadResult.Retry("server has different content for chunks $conflicts", uploaded)
        val lost = store.needsAttention()
        return if (lost.isEmpty()) UploadResult.Done(uploaded) else UploadResult.Incomplete(uploaded, lost)
    }

    /**
     * Which account this phone's key uploads as, from the server; for an older server that can't say,
     * the key alone identifies it. A bad key is fatal: nothing can upload until it's fixed.
     */
    private fun whoAmI(): Any {
        val r = request("GET", "$baseUrl/api/v1/me", emptyMap(), null, null)
        if (r.code == 404) return UploadTarget.of(baseUrl, token)
        if (r.code == 401) return UploadResult.Fatal("HTTP 401 ${r.body.take(200)} (check device token)")
        if (r.code !in 200..299) return UploadResult.Retry("who am I: HTTP ${r.code} ${r.body.take(200)}", 0)
        val acct = runCatching { org.json.JSONObject(r.body).optJSONObject("account") }.getOrNull()
        return UploadTarget.of(baseUrl, token, acct?.optString("id")?.ifEmpty { null }, acct?.optString("name")?.ifEmpty { null })
    }

    /**
     * Whether recording [id] goes to [now]. A recording keeps the server and account it was recorded
     * under: after someone else signs in on the phone (or the phone moves to another server) it waits
     * instead of uploading as them. One recorded with no account at all, or before phones kept
     * targets, goes where uploads go now.
     */
    private fun mayUpload(id: String, now: UploadTarget): Boolean {
        var t = store.target(id)
        if (t == null || (t.key.isEmpty() && t.account == null)) {
            t = now
            store.setTarget(id, t)
        } else if (t.account == null && now.account != null && t.server == now.server && t.key == now.key) {
            t = t.copy(account = now.account, accountName = now.accountName)
            store.setTarget(id, t)
        }
        return t.sameAs(now) && store.refusal(id, now.key) == null
    }

    private fun refuse(id: String, r: Response): UploadResult {
        store.markRefused(id, current?.key ?: "", r.body.take(200).ifBlank { "HTTP ${r.code}" })
        return REFUSED
    }

    private fun classify(r: Response, what: String): UploadResult? = when (r.code) {
        in 200..299 -> null
        401, 403 -> UploadResult.Fatal("$what: HTTP ${r.code} ${r.body.take(200)} (check device token)")
        404 -> UploadResult.Fatal("$what: HTTP 404 ${r.body.take(200)} (check server URL)")
        else -> UploadResult.Retry("$what: HTTP ${r.code} ${r.body.take(200)}", 0)
    }

    private fun putMetaIfChanged(id: String): UploadResult? {
        val hash = store.metaHash(id)
        if (store.uploadedMetaHash(id) == hash) return null
        val body = File(store.dir(id), RecordingStore.META).readBytes()
        val r = request("PUT", "$baseUrl/api/v1/recordings/$id", mapOf("Content-Type" to "application/json"), body, null)
        // 403 here: the trip is someone else's on the server (or this key can't upload). Only it waits.
        if (r.code == 403 || r.code == 409) return refuse(id, r)
        classify(r, "metadata $id")?.let { return it }
        // Hash of the bytes actually sent; if the file changed meanwhile it is re-sent next time.
        store.markMetaUploaded(id, RecordingStore.sha256(body))
        return null
    }

    /**
     * Once a finished recording's chunks and final metadata are all acknowledged, asks the server
     * whether it really holds every chunk 0 until chunkCount. Only its yes lets the phone delete
     * the recording. A chunk the server lacks is sent again if the phone still has it (returned as a
     * retry, so it goes out soon); one the phone no longer has is recorded for the UI to show, not
     * retried forever.
     */
    private fun verifyIfFinished(id: String): UploadResult? {
        if (store.serverComplete(id)) return null
        val meta = store.readMeta(id)
        if (meta.optString("status") == "recording" || store.pendingChunks(id).isNotEmpty() ||
            store.unfinishedFiles(id).isNotEmpty() || store.uploadedMetaHash(id) != store.metaHash(id)) return null
        val r = request("POST", "$baseUrl/api/v1/recordings/$id/verify", emptyMap(), ByteArray(0), null)
        if (r.code == 404) return null // an older server without /verify: keep the local copy
        classify(r, "verify $id")?.let { return it }
        val body = runCatching { org.json.JSONObject(r.body) }.getOrNull() ?: return null
        if (body.optBoolean("complete")) {
            store.markServerComplete(id)
            runCatching { onServerComplete(id) }
            return null
        }
        val missing = body.optJSONArray("missing")?.let { a -> (0 until a.length()).map { a.getInt(it) } } ?: emptyList()
        val resent = missing.filter { store.resend(id, it) }
        store.markServerMissing(id, missing - resent.toSet())
        return if (resent.isNotEmpty()) UploadResult.Retry("server was missing chunks $resent of $id; sending them again", 0) else null
    }

    private fun putChunk(id: String, seq: Int): UploadResult? {
        val meta = store.chunkMeta(id, seq)
        var metaJson = meta.toString()
        // Headers up to 64 KB were verified against Cloudflare; a 60 s chunk's 1 Hz track is ~5 KB.
        // The engine summary is ~8 KB a minute. Too big: drop it first, then the track (raw data has
        // both). Each summary goes with every key that describes it, so nothing claims a summary
        // that isn't there, and `summaryOmitted` tells the web page to rebuild it from the raw chunk.
        // The list still needs a route, so a dropped track leaves a thinned `routeOutline` behind.
        val omitted = org.json.JSONArray()
        for ((name, keys) in SUMMARY_GROUPS) {
            if (metaJson.length <= MAX_META_HEADER) break
            val track = if (name == "track") meta.optJSONArray("track") else null
            keys.forEach { meta.remove(it) }
            omitted.put(name)
            meta.put("summaryOmitted", omitted)
            metaJson = meta.toString()
            if (track != null && !meta.has("routeOutline")) {
                RouteOutline.fit(track, MAX_META_HEADER - metaJson.length - 20)?.let { meta.put("routeOutline", it) }
                metaJson = meta.toString()
            }
        }
        if (metaJson.length > MAX_META_HEADER && meta.has("routeOutline")) {
            // A recovered chunk's outline, still too big alongside everything else.
            val outline = meta.getJSONArray("routeOutline")
            meta.remove("routeOutline")
            metaJson = meta.toString()
            RouteOutline.fit(outline, MAX_META_HEADER - metaJson.length - 20)?.let { meta.put("routeOutline", it) }
            metaJson = meta.toString()
        }
        val headers = mapOf(
            "Content-Type" to "application/gzip",
            "X-Fuelish-Sha256" to meta.getString("sha256"),
            "X-Fuelish-Meta" to Base64.getUrlEncoder().withoutPadding().encodeToString(metaJson.toByteArray()),
        )
        val r = request("PUT", "$baseUrl/api/v1/recordings/$id/chunks/$seq", headers, null, store.chunkFile(id, seq))
        if (r.code == 409) return CONFLICT
        if (r.code == 403) return refuse(id, r)
        classify(r, "chunk $id/$seq")?.let { return it }
        store.markChunkUploaded(id, seq, deleteAfterUpload)
        return null
    }

    companion object {
        private val LOCK = ReentrantLock()
        const val MAX_META_HEADER = 40_000
        val SUMMARY_GROUPS = listOf(
            "engine" to listOf("engine", "engineCols", "engineFormat", "fuelEstVersion"),
            "track" to listOf("track", "trackFormat"),
        )
    }

    private fun request(method: String, url: String, headers: Map<String, String>, body: ByteArray?, file: File?): Response {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 20_000
            c.readTimeout = 120_000
            c.setRequestProperty("Authorization", "Bearer $token")
            headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
            if (body != null || file != null) {
                c.doOutput = true
                val len = body?.size?.toLong() ?: file!!.length()
                c.setFixedLengthStreamingMode(len)
                c.outputStream.use { os -> if (body != null) os.write(body) else file!!.inputStream().use { it.copyTo(os) } }
            }
            val code = c.responseCode
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText().orEmpty()
            return Response(code, text)
        } finally {
            c.disconnect()
        }
    }
}
