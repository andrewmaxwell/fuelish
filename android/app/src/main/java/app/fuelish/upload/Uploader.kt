package app.fuelish.upload

import app.fuelish.record.RecordingStore
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

private val CONFLICT = UploadResult.Retry("conflict", 0)

sealed class UploadResult {
    data class Done(val chunks: Int) : UploadResult()
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
) {
    class Response(val code: Int, val body: String)

    private fun UploadResult.withChunks(n: Int) = if (this is UploadResult.Retry) copy(chunks = n) else this

    fun uploadAll(): UploadResult {
        if (baseUrl.isBlank() || token.isBlank()) return UploadResult.Fatal("server URL or device token not set")
        var uploaded = 0
        val conflicts = mutableListOf<String>()
        try {
            for (id in store.ids()) {
                if (store.fullyUploaded(id)) continue
                putMetaIfChanged(id)?.let { return it.withChunks(uploaded) }
                for (seq in store.pendingChunks(id)) {
                    when (val r = putChunk(id, seq)) {
                        null -> uploaded++
                        CONFLICT -> conflicts += "$id/$seq"
                        else -> return r.withChunks(uploaded)
                    }
                }
                putMetaIfChanged(id)?.let { return it.withChunks(uploaded) }
            }
        } catch (e: IOException) {
            return UploadResult.Retry(e.toString(), uploaded)
        }
        // A conflict means the server holds different bytes for that seq. Never overwrite;
        // keep the local copy and keep reporting it, without blocking other chunks.
        if (conflicts.isNotEmpty()) return UploadResult.Retry("server has different content for chunks $conflicts", uploaded)
        return UploadResult.Done(uploaded)
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
        classify(r, "metadata $id")?.let { return it }
        // Hash of the bytes actually sent; if the file changed meanwhile it is re-sent next time.
        store.markMetaUploaded(id, RecordingStore.sha256(body))
        return null
    }

    private fun putChunk(id: String, seq: Int): UploadResult? {
        val meta = store.chunkMeta(id, seq)
        var metaJson = meta.toString()
        if (metaJson.length > 12_000) {
            meta.remove("track")
            metaJson = meta.toString()
        }
        val headers = mapOf(
            "Content-Type" to "application/gzip",
            "X-Fuelish-Sha256" to meta.getString("sha256"),
            "X-Fuelish-Meta" to Base64.getUrlEncoder().withoutPadding().encodeToString(metaJson.toByteArray()),
        )
        val r = request("PUT", "$baseUrl/api/v1/recordings/$id/chunks/$seq", headers, null, store.chunkFile(id, seq))
        if (r.code == 409) return CONFLICT
        classify(r, "chunk $id/$seq")?.let { return it }
        store.markChunkUploaded(id, seq)
        return null
    }

    private fun request(method: String, url: String, headers: Map<String, String>, body: ByteArray?, file: File?): Response {
        val c = URL(url).openConnection() as HttpURLConnection
        try {
            c.requestMethod = method
            c.connectTimeout = 20_000
            c.readTimeout = 120_000
            c.doOutput = true
            c.setRequestProperty("Authorization", "Bearer $token")
            headers.forEach { (k, v) -> c.setRequestProperty(k, v) }
            val len = body?.size?.toLong() ?: file!!.length()
            c.setFixedLengthStreamingMode(len)
            c.outputStream.use { os -> if (body != null) os.write(body) else file!!.inputStream().use { it.copyTo(os) } }
            val code = c.responseCode
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText().orEmpty()
            return Response(code, text)
        } finally {
            c.disconnect()
        }
    }
}
