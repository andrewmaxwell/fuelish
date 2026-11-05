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
        assertEquals("every GPS fix is in the track summary", 50, trackPoints)
        assertEquals(RecordingWriter.TRACK_FORMAT, closed[0].meta.getInt("trackFormat"))
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
    fun engineSummaryAveragesEachSecond() {
        var t = 0L
        val dir = tmp.newFolder("eng")
        val closed = mutableListOf<ChunkInfo>()
        val w = RecordingWriter(dir, "r2", chunkSeconds = 60, chunkMaxBytes = 1 shl 30,
            elapsedNs = { t }, wallMs = { 10_000L + t / 1_000_000 }, onChunkClosed = { closed += it })
        w.start()
        // Second 10: rpm 1000 and 2000; second 11: rpm 3000 and speed 50. A non-summary value is ignored.
        for ((ms, f, v) in listOf(Triple(100L, "rpm", 1000.0), Triple(600L, "rpm", 2000.0), Triple(1200L, "rpm", 3000.0), Triple(1300L, "speed", 50.0))) {
            t = ms * 1_000_000
            w.emit("obd:$f", t, JsonLine("obd").build(), doubleArrayOf(v))
        }
        t = 1_400_000_000
        w.emit("obd:baro", t, JsonLine("obd").build())
        w.stop()
        val m = closed.single().meta
        assertEquals(RecordingWriter.ENGINE_FORMAT, m.getInt("engineFormat"))
        assertEquals("[\"rpm\",\"speed\"]", m.getJSONArray("engineCols").toString())
        val rows = m.getJSONArray("engine")
        assertEquals("[10500,1500,null]", rows.getJSONArray(0).toString())
        assertEquals("[11500,3000,50]", rows.getJSONArray(1).toString())
        assertEquals("OBD values stay out of the GPS track", 0, m.getJSONArray("track").length())
    }

    @Test
    fun recoveryCountsChunksAlreadyUploadedAndDeleted() {
        val store = RecordingStore(tmp.newFolder("root2"))
        val id = "20261103T000000Z-beef"
        store.writeMeta(id, JSONObject().put("id", id).put("status", "recording").put("startedWallMs", 1L))
        val d = store.dir(id)
        for (seq in 0..1) {
            val raw = File(d, RecordingWriter.chunkName(seq, ".ndjson")).apply { writeText("{\"k\":\"a\"}\n") }
            RecordingWriter.finalizeChunk(d, seq, raw, JSONObject())
            store.markChunkUploaded(id, seq, deleteData = true) // uploaded mid-drive, then the app was killed
        }
        File(d, RecordingWriter.chunkName(2, ".ndjson")).writeText("{\"k\":\"b\"}\n")
        store.recover { null }
        assertEquals(3, store.readMeta(id).getInt("chunkCount"))
        assertEquals(listOf(2), store.pendingChunks(id))
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

        store.markChunkUploaded(id, 0, deleteData = true)
        assertEquals(listOf(1), store.pendingChunks(id))
        assertEquals(listOf(0, 1), store.finishedChunks(id))
        // The active recording is never touched.
        store.writeMeta("active", JSONObject().put("id", "active").put("status", "recording"))
        assertEquals(emptyList<String>(), store.recover { "active" })
        assertEquals("recording", store.readMeta("active").getString("status"))
    }

    @Test
    fun recoveryKeepsClockAndStreamInventory() {
        val store = RecordingStore(tmp.newFolder())
        store.writeMeta("r", JSONObject().put("id", "r").put("status", "recording").put("startedWallMs", 1000))
        File(store.dir("r"), RecordingWriter.chunkName(0, ".ndjson")).writeText(
            "{\"k\":\"chunk\",\"v\":1,\"rec\":\"r\",\"seq\":0,\"rx\":5000000,\"wall\":1700000000000}\n" +
                "{\"k\":\"obd\",\"tx\":5100000,\"rx\":6000000,\"ecu\":\"7E8\",\"pid\":\"0C\",\"f\":\"rpm\",\"val\":800}\n" +
                "{\"k\":\"loc\",\"p\":\"gps\",\"et\":7000000,\"time\":1700000000002}\n" +
                "{\"k\":\"obd\",\"rx\":90", // torn by the crash
        )
        assertEquals(listOf("r"), store.recover { null })
        val m = store.chunkMeta("r", 0)
        assertEquals(5000000L, m.getLong("firstNs"))
        assertEquals(1700000000000L, m.getLong("wallStartMs"))
        assertTrue(m.getJSONObject("streams").has("obd:rpm"))
        assertTrue(m.getJSONObject("streams").has("loc:gps"))
        assertEquals(1, store.readMeta("r").getInt("chunkCount"))
    }

    @Test
    fun recoveredChunkGetsARouteOutlineFromItsGpsLines() {
        val store = RecordingStore(tmp.newFolder())
        store.writeMeta("r", JSONObject().put("id", "r").put("status", "recording").put("startedWallMs", 1000))
        val lines = StringBuilder("{\"k\":\"chunk\",\"v\":1,\"rec\":\"r\",\"seq\":0,\"rx\":5000000,\"wall\":1700000000000}\n")
        for (i in 0 until 20) {
            lines.append("{\"k\":\"loc\",\"p\":\"gps\",\"et\":${7000000 + i},\"time\":${1700000000000L + i * 1000},\"lat\":${38.0 + i * 1e-4},\"lon\":-90.0,\"speed\":12.5,\"hAcc\":4.0}\n")
        }
        lines.append("{\"k\":\"loc\",\"p\":\"fused\",\"time\":1700000000500,\"lat\":1,\"lon\":1}\n") // not GPS: left out
        File(store.dir("r"), RecordingWriter.chunkName(0, ".ndjson")).writeText(lines.toString())
        store.recover { null }
        val outline = store.chunkMeta("r", 0).getJSONArray("routeOutline")
        assertEquals(20, outline.length())
        assertEquals(38.0, outline.getJSONArray(0).getDouble(1), 1e-9)
        assertEquals(12.5, outline.getJSONArray(0).getDouble(3), 1e-9)
    }

    @Test
    fun engineSummaryEstimatesFuelPerSample() {
        // Half a second fueling at lambda 1, half in fuel cut (lambda 2), constant airflow.
        val e = EngineSummary()
        e.add("commanded_lambda", 0, 1.0)
        e.add("maf", 100, 14.08)
        e.add("maf", 200, 14.08)
        e.add("commanded_lambda", 500, 2.0)
        e.add("maf", 600, 14.08)
        e.add("maf", 700, 14.08)
        e.add("mil_on", 100, 1.0)
        e.add("mil_on", 900, 0.0)
        val cols = (0 until e.columns().length()).map { e.columns().getString(it) }
        val row = e.rows().getJSONArray(0)
        assertEquals(0.5, row.getDouble(1 + cols.indexOf("fuel_est_gs")), 1e-9) // not 0.667 from averaged inputs
        assertEquals(0.5, row.getDouble(1 + cols.indexOf("fuel_cut")), 1e-9)
        assertEquals(0.0, row.getDouble(1 + cols.indexOf("mil_on")), 1e-9) // last state, not a mean
    }
}
