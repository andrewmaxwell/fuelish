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
                parts[0] !in metas -> 404 to "upload recording metadata first"
                failNextChunks > 0 -> {
                    failNextChunks--
                    500 to "boom"
                }
                else -> {
                    val sha = MessageDigest.getInstance("SHA-256").digest(body).joinToString("") { "%02x".format(it) }
                    val key = parts[0] + "/" + parts[2]
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
}
