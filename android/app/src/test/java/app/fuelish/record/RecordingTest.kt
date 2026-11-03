package app.fuelish.record

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.zip.GZIPInputStream

class RecordingTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test
    fun jsonLineEscapesAndNests() {
        val line = JsonLine("x").s("q", "a\"b\\c\r\n\u0001").d("nan", Double.NaN).f("f", 1.5f)
            .obj("o") { n("a", 1).arr("l") { arrObj { n("b", 2) }; arrObj { n("b", 3) } } }
            .floats("v", floatArrayOf(1f, Float.POSITIVE_INFINITY)).build()
        val o = JSONObject(line)
        assertEquals("a\"b\\c\r\n\u0001", o.getString("q"))
        assertTrue(o.isNull("nan"))
        assertEquals(3, o.getJSONObject("o").getJSONArray("l").getJSONObject(1).getInt("b"))
        assertTrue(o.getJSONArray("v").isNull(1))
    }

    private fun gunzipLines(f: File) = GZIPInputStream(f.inputStream()).bufferedReader().readLines()

    @Test
    fun writerRotatesChunksAndKeepsEveryRecord() {
        var t = 0L
        val dir = tmp.newFolder("rec")
        val closed = mutableListOf<ChunkInfo>()
        val w = RecordingWriter(dir, "r1", chunkSeconds = 1, chunkMaxBytes = 1 shl 30,
            elapsedNs = { t }, wallMs = { t / 1_000_000 }, onChunkClosed = { closed += it })
        w.start()
        for (i in 0 until 5000) {
            t = i * 1_000_000L // 1 kHz for 5 s
            w.emit("s:acc", t, JsonLine("s").n("i", i).build())
            if (i % 100 == 0) w.emit("loc:gps", t, JsonLine("loc").build(), doubleArrayOf(t.toDouble(), 37.0, -122.0, 1.0, 5.0))
            if (i % 500 == 0) Thread.sleep(5)
        }
        val n = w.stop()
        assertTrue("expected rotation, got $n chunks", n >= 2)
        assertEquals(n, closed.size)
        val all = (0 until n).flatMap { gunzipLines(File(dir, RecordingWriter.chunkName(it, ".ndjson.gz"))) }
        val trackPoints = closed.sumOf { it.meta.getJSONArray("track").length() }
        assertTrue("track preview missing", trackPoints >= 1)
        val ids = all.map { JSONObject(it) }.filter { it.getString("k") == "s" }.map { it.getInt("i") }
        assertEquals((0 until 5000).toList(), ids)
        assertEquals(0L, w.dropped.get())
        // Every chunk starts with a self-describing header.
        assertEquals("chunk", JSONObject(gunzipLines(closed[1].gzFile)[0]).getString("k"))
        val stats = closed.sumOf { it.meta.getJSONObject("streams").getJSONObject("s:acc").getLong("n") }
        assertEquals(5000L, stats)
        assertEquals(1_000_000L, closed[0].meta.getJSONObject("streams").getJSONObject("s:acc").getLong("minDtNs"))
    }

    @Test
    fun recoveryFinishesCrashedRecording() {
        val store = RecordingStore(tmp.newFolder("root"))
        val id = "20261103T000000Z-abcd"
        store.writeMeta(id, JSONObject().put("id", id).put("status", "recording").put("startedWallMs", 1L))
        // Chunk 0 finished normally, chunk 1 left raw by a crash.
        val d = store.dir(id)
        val raw0 = File(d, RecordingWriter.chunkName(0, ".ndjson")).apply { writeText("{\"k\":\"a\"}\n") }
        RecordingWriter.finalizeChunk(d, 0, raw0, JSONObject())
        File(d, RecordingWriter.chunkName(1, ".ndjson")).writeText("{\"k\":\"b\"}\n{\"k\":\"c\"}\n")

        assertEquals(listOf(id), store.recover { null })
        val meta = store.readMeta(id)
        assertEquals("interrupted", meta.getString("status"))
        assertEquals(2, meta.getInt("chunkCount"))
        assertEquals(listOf(0, 1), store.pendingChunks(id))
        assertEquals(2, store.chunkMeta(id, 1).getInt("records"))
        assertEquals(listOf("{\"k\":\"b\"}", "{\"k\":\"c\"}"), gunzipLines(store.chunkFile(id, 1)))

        store.markChunkUploaded(id, 0)
        assertEquals(listOf(1), store.pendingChunks(id))
        // The active recording is never touched.
        store.writeMeta("active", JSONObject().put("id", "active").put("status", "recording"))
        assertEquals(emptyList<String>(), store.recover { "active" })
        assertEquals("recording", store.readMeta("active").getString("status"))
    }
}
