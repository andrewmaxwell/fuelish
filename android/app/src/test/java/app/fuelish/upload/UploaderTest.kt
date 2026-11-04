package app.fuelish.upload

import app.fuelish.record.RecordingStore
import app.fuelish.record.RecordingWriter
import com.sun.net.httpserver.HttpServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.InetSocketAddress
import java.security.MessageDigest

class UploaderTest {
    @get:Rule val tmp = TemporaryFolder()

    private lateinit var server: HttpServer
    private val chunks = HashMap<String, String>() // "id/seq" -> sha
    private val metas = HashMap<String, String>()
    private var failNextChunks = 0
    private var serverLosesChunks = false
    private val chunkMetaHeaders = HashMap<String, JSONObject>()
    private var requests = 0
    private val base get() = "http://127.0.0.1:${server.address.port}"

    @Before
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/v1/recordings/") { ex ->
            requests++
            val body = ex.requestBody.readBytes()
            val parts = ex.requestURI.path.removePrefix("/api/v1/recordings/").split("/")
            val (code, text) = when {
                ex.requestHeaders.getFirst("Authorization") != "Bearer tok" -> 401 to "bad token"
                parts.size == 1 -> {
                    metas[parts[0]] = String(body)
                    200 to "{}"
                }
                parts.size == 2 && parts[1] == "verify" -> {
                    val n = JSONObject(metas[parts[0]] ?: "{}").optInt("chunkCount", -1)
                    val complete = n >= 0 && (0 until n).all { chunks.containsKey(parts[0] + "/" + it) } && !serverLosesChunks
                    200 to "{\"complete\":$complete}"
                }
                parts[0] !in metas -> 404 to "upload recording metadata first"
                failNextChunks > 0 -> {
                    failNextChunks--
                    500 to "boom"
                }
                else -> {
                    val sha = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
                    val key = parts[0] + "/" + parts[2]
                    val metaHeader = ex.requestHeaders.getFirst("X-Fuelish-Meta")
                    if (metaHeader != null) chunkMetaHeaders[key] = JSONObject(String(java.util.Base64.getUrlDecoder().decode(metaHeader)))
                    when {
                        sha != ex.requestHeaders.getFirst("X-Fuelish-Sha256") -> 422 to "sha mismatch"
                        chunks[key] == null -> {
                            chunks[key] = sha
                            201 to "{}"
                        }
                        chunks[key] == sha -> 200 to "{\"duplicate\":true}"
                        else -> 409 to "conflict"
                    }
                }
            }
            ex.sendResponseHeaders(code, text.length.toLong())
            ex.responseBody.use { it.write(text.toByteArray()) }
        }
        server.start()
    }

    @After
    fun stop() = server.stop(0)

    private fun makeRecording(store: RecordingStore, id: String, n: Int, status: String = "stopped") {
        store.writeMeta(id, JSONObject().put("id", id).put("deviceId", "d").put("status", status).put("startedWallMs", 1).put("chunkCount", n))
        for (seq in 0 until n) {
            val raw = File(store.dir(id), RecordingWriter.chunkName(seq, ".ndjson")).apply { writeText("{\"k\":\"x\",\"seq\":$seq}\n") }
            RecordingWriter.finalizeChunk(store.dir(id), seq, raw, JSONObject().put("seq", seq))
        }
    }

    @Test
    fun uploadsEverythingOnce() {
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "a", 3)
        makeRecording(store, "b", 2)
        val up = Uploader(store, base, "tok")
        val r = up.uploadAll()
        assertEquals(UploadResult.Done(5), r)
        assertEquals(5, chunks.size)
        assertTrue(store.fullyUploaded("a") && store.fullyUploaded("b"))

        // Nothing left: no further requests.
        val before = requests
        assertEquals(UploadResult.Done(0), up.uploadAll())
        assertEquals(before, requests)
    }

    @Test
    fun transientErrorThenRetryCompletesWithoutDuplicates() {
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "a", 3)
        failNextChunks = 1
        val first = Uploader(store, base, "tok").uploadAll()
        assertTrue(first is UploadResult.Retry)
        assertEquals(3, store.pendingChunks("a").size)
        val second = Uploader(store, base, "tok").uploadAll()
        assertEquals(UploadResult.Done(3), second)
        assertEquals(3, chunks.size)
    }

    @Test
    fun lostAckIsHarmless() {
        // Server stored the chunk but the phone never saw the response: the re-send is a duplicate.
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "a", 1)
        Uploader(store, base, "tok").uploadAll()
        File(store.dir("a"), RecordingWriter.chunkName(0, ".uploaded")).delete()
        assertEquals(UploadResult.Done(1), Uploader(store, base, "tok").uploadAll())
        assertEquals(1, chunks.size)
    }

    @Test
    fun deleteAfterUploadFreesOnlyAcknowledgedData() {
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "done", 2)
        makeRecording(store, "live", 2, status = "recording")
        val up = Uploader(store, base, "tok", deleteAfterUpload = true)
        assertEquals(UploadResult.Done(4), up.uploadAll())
        // Finished and complete on the server: removed from the phone.
        assertTrue(!store.dir("done").exists())
        // Still recording: chunk data deleted, but folder, metadata and markers stay.
        assertTrue(store.dir("live").exists())
        assertEquals(listOf(0, 1), store.finishedChunks("live"))
        assertTrue(!store.chunkFile("live", 0).exists())
        assertEquals(emptyList<Int>(), store.pendingChunks("live"))

        // A failed upload deletes nothing that wasn't acknowledged.
        makeRecording(store, "flaky", 2)
        failNextChunks = 1
        assertTrue(up.uploadAll() is UploadResult.Retry)
        assertEquals(listOf(0, 1), store.pendingChunks("flaky"))
        assertTrue(store.chunkFile("flaky", 0).exists() && store.chunkFile("flaky", 1).exists())
        assertEquals(UploadResult.Done(2), up.uploadAll())
        assertTrue(!store.dir("flaky").exists())
        assertEquals(6, chunks.size)
    }

    @Test
    fun badTokenIsFatal() {
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "a", 1)
        assertTrue(Uploader(store, base, "wrong").uploadAll() is UploadResult.Fatal)
        assertEquals(listOf(0), store.pendingChunks("a"))
    }

    @Test
    fun activeRecordingUploadsFinishedChunksAndStaysOpen() {
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "live", 2, status = "recording")
        assertEquals(UploadResult.Done(2), Uploader(store, base, "tok").uploadAll())
        assertTrue(!store.fullyUploaded("live"))
        assertTrue(metas["live"]!!.contains("\"recording\""))
    }

    @Test
    fun unfinishedRawChunkBlocksDeletion() {
        // The review's case: a stopped recording whose last chunk was never finished (writer error).
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "a", 1)
        val raw = File(store.dir("a"), RecordingWriter.chunkName(1, ".ndjson")).apply { writeText("{\"k\":\"chunk\",\"rx\":5,\"wall\":9}\n") }
        val up = Uploader(store, base, "tok", deleteAfterUpload = true)
        up.uploadAll()
        assertTrue("raw data must survive", raw.exists())
        assertTrue(!store.fullyUploaded("a"))
        // Once it is finalized (as the service now does) and the count includes it, it uploads and then goes.
        store.finalizeLeftovers("a")
        store.writeMeta("a", store.readMeta("a").put("chunkCount", 2))
        assertEquals(UploadResult.Done(1), up.uploadAll())
        assertTrue(!store.dir("a").exists())
        assertEquals(2, chunks.keys.count { it.startsWith("a/") })
    }

    @Test
    fun missingExpectedChunksBlockDeletion() {
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "a", 0)
        store.writeMeta("a", store.readMeta("a").put("chunkCount", 3)) // says 3, has none
        Uploader(store, base, "tok", deleteAfterUpload = true).uploadAll()
        assertTrue(store.dir("a").exists())
        assertTrue(!store.fullyUploaded("a"))
    }

    @Test
    fun serverMustConfirmCompletenessBeforeDeletion() {
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "a", 2)
        serverLosesChunks = true
        Uploader(store, base, "tok", deleteAfterUpload = true).uploadAll()
        assertTrue(store.dir("a").exists())
        serverLosesChunks = false
        Uploader(store, base, "tok", deleteAfterUpload = true).uploadAll()
        assertTrue(!store.dir("a").exists())
    }

    @Test
    fun oversizedSummaryIsDroppedWithItsFormatMarker() {
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "a", 1)
        val metaFile = File(store.dir("a"), RecordingWriter.chunkName(0, ".meta.json"))
        val m = JSONObject(metaFile.readText())
        val rows = org.json.JSONArray().apply { repeat(4000) { put(org.json.JSONArray(listOf(it, 1.234, 5.678))) } }
        m.put("engineFormat", 1).put("engineCols", org.json.JSONArray(listOf("rpm", "maf"))).put("engine", rows)
            .put("trackFormat", 2).put("track", org.json.JSONArray(listOf(org.json.JSONArray(listOf(1, 2, 3)))))
        metaFile.writeText(m.toString())
        assertEquals(UploadResult.Done(1), Uploader(store, base, "tok").uploadAll())
        val sent = chunkMetaHeaders["a/0"]!!
        assertTrue(!sent.has("engine") && !sent.has("engineFormat") && !sent.has("engineCols"))
        assertEquals("engine", sent.getJSONArray("summaryOmitted").getString(0))
        assertTrue(sent.has("track") && sent.getInt("trackFormat") == 2) // small enough once engine is gone
    }

    @Test
    fun metadataRevisionOnlyGoesUp() {
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "a", 0)
        val r1 = store.readMeta("a").getLong("rev")
        store.writeMeta("a", JSONObject().put("id", "a").put("rev", 0)) // a stale in-memory copy
        assertTrue(store.readMeta("a").getLong("rev") > r1)
    }

    @Test
    fun concurrentUploadsDoNotOverlap() {
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "a", 20)
        val results = java.util.Collections.synchronizedList(mutableListOf<UploadResult>())
        val threads = (1..3).map { Thread { results += Uploader(store, base, "tok").uploadAll() } }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        // Every chunk was sent exactly once in total across the three uploaders.
        assertEquals(20, results.sumOf { (it as UploadResult.Done).chunks })
    }

    @Test
    fun cancellationStopsBetweenChunks() {
        val store = RecordingStore(tmp.newFolder())
        makeRecording(store, "a", 5)
        var n = 0
        val r = Uploader(store, base, "tok") { n++ >= 3 }.uploadAll()
        assertTrue(r is UploadResult.Retry)
        assertTrue(store.pendingChunks("a").isNotEmpty())
    }
}
