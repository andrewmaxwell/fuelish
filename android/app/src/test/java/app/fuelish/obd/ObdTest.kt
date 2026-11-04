package app.fuelish.obd

import app.fuelish.Config
import app.fuelish.record.RecordSink
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections

class ObdTest {
    @Test
    fun parsesSingleAndMultiFrameCan() {
        val msgs = ObdParser.parse(
            listOf("7E804410C1AF8", "7E81013490201324847", "7E8214643324635584748", "7E82230303030303000"),
            6,
        )
        assertEquals(2, msgs.size)
        assertEquals("410C1AF8", ObdParser.toHex(msgs[0].payload))
        assertEquals("7E8", msgs[1].ecu)
        assertEquals(19, msgs[1].payload.size)
    }

    @Test
    fun splitsMultiPidResponseAndDecodes() {
        val payload = ObdParser.hexToBytes("410C1AF80D3210019011FF")!!
        val vals = Mode01.split(payload, listOf(0x0C, 0x0D, 0x10, 0x11))
        assertEquals(listOf(0x0C, 0x0D, 0x10, 0x11), vals.map { it.pid })
        assertEquals(1726.0, vals[0].def!!.fields[0].decode(vals[0].data), 1e-9)
        assertEquals(50.0, vals[1].def!!.fields[0].decode(vals[1].data), 1e-9)
        assertEquals(4.0, vals[2].def!!.fields[0].decode(vals[2].data), 1e-9)
        assertEquals(100.0, vals[3].def!!.fields[0].decode(vals[3].data), 1e-9)
    }

    @Test
    fun bitmapDecoding() {
        // 0100 -> BE 1F A8 13 is the classic example: 01,03-07,0C-10,11,13,15,1C,1F,20
        val pids = Pids.decodeBitmap(0, intArrayOf(0xBE, 0x1F, 0xA8, 0x13))
        assertEquals(listOf(1, 3, 4, 5, 6, 7, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x13, 0x15, 0x1C, 0x1F, 0x20), pids)
    }

    @Test
    fun allowlistRejectsWritesAndClears() {
        for (bad in listOf("04", "0400", "08", "2E1234", "3101", "ATMA", "ATPP", "10 03", "STPX", "ATBRD")) {
            assertThrows(bad, IllegalArgumentException::class.java) { ElmAllowlist.check(bad) }
        }
        for (ok in listOf("ATZ", "ATSP0", "0100", "010C0D11", "0902", "03", "STDI", "ATRV")) ElmAllowlist.check(ok)
    }

    @Test
    fun schedulerKeepsFastSignalsDominantButServesSlowOnes() {
        val fast = listOf(0x0C, 0x0D, 0x11).map { PollItem(it, 0, PollScheduler.FAST, true) }
        val slow = (0x40 until 0x50).map { PollItem(it, 5_000_000_000L, "slow", true) }
        val s = PollScheduler(fast + slow, 1)
        var t = 0L
        while (t < 60_000_000_000L) { // 60 s at 50 ms per request
            val b = s.next(t)
            t += 50_000_000
            s.completed(b, b.map { it.pid }.toSet(), t)
        }
        val fastPolls = fast.sumOf { it.polls }
        val slowPolls = slow.sumOf { it.polls }
        assertTrue("each slow pid ~every 5 s, got ${slow.map { it.polls }}", slow.all { it.polls in 9..13 })
        assertTrue("fast share ${fastPolls}/${fastPolls + slowPolls}", fastPolls > slowPolls * 3)
    }

    @Test
    fun schedulerBatchesWhenAllowed() {
        val items = listOf(0x0C, 0x0D, 0x11, 0x04).map { PollItem(it, 0, PollScheduler.FAST, true) } +
            PollItem(0x05, 5_000_000_000L, "slow", true)
        val s = PollScheduler(items, 3)
        assertEquals(3, s.next(0).size)
    }

    @Test
    fun schedulerRestoresDemotedPidWhenAnsweredAgain() {
        val fast = PollItem(0x0C, 0, PollScheduler.FAST, true)
        val s = PollScheduler(listOf(fast), 1)
        fast.intervalNs = 30_000_000_000L // demoted
        assertEquals(listOf(fast), s.completed(listOf(fast), setOf(0x0C), 1))
        assertEquals(0L, fast.intervalNs)
        assertFalse(fast.demoted)
    }

    @Test
    fun schedulerDoesNotCountWholeCarSilenceAsMisses() {
        val items = listOf(0x0C, 0x0D, 0x11).map { PollItem(it, 0, PollScheduler.FAST, true) }
        val s = PollScheduler(items, 3)
        repeat(10) { s.completed(items, emptySet(), it.toLong()) }
        assertTrue(items.all { it.consecutiveMisses == 0 })
        // One PID unanswered while others answer is a real miss.
        s.completed(items, setOf(0x0C, 0x0D), 11)
        assertEquals(1, items.first { it.pid == 0x11 }.consecutiveMisses)
        // So is a single-PID request with no answer.
        s.completed(listOf(items[0]), emptySet(), 12)
        assertEquals(1, items[0].consecutiveMisses)
    }

    private class CollectSink : RecordSink {
        val lines: MutableList<Pair<String, String>> = Collections.synchronizedList(mutableListOf())
        val summarized: MutableList<Pair<String, Double>> = Collections.synchronizedList(mutableListOf())
        override fun emit(stream: String, tNs: Long, line: String, track: DoubleArray?) {
            lines += stream to line
            if (track != null) summarized += stream to track[0]
        }
        fun streams() = synchronized(lines) { lines.map { it.first } }
    }

    private fun runRecorder(fake: FakeElm, cfgOverride: String = "{}", until: (CollectSink) -> Boolean): Pair<ObdRecorder, CollectSink> {
        val cfg = Config.parse("""{"obd": $cfgOverride}""").obd
        val sink = CollectSink()
        val rec = ObdRecorder(cfg, { fake }, sink, System::nanoTime, sleep = { Thread.sleep(minOf(it, 20)) })
        rec.start()
        val deadline = System.currentTimeMillis() + 10_000
        while (!until(sink) && System.currentTimeMillis() < deadline) Thread.sleep(10)
        rec.stop()
        return rec to sink
    }

    @Test
    fun endToEndAgainstFakeAdapter() {
        val fake = FakeElm()
        val (rec, sink) = runRecorder(fake) { s -> s.streams().count { it == "obd:rpm" } >= 50 }
        val streams = sink.streams()
        assertTrue(streams.count { it == "obd:rpm" } >= 50)
        assertTrue("obd_discovery" in streams)
        assertTrue("obd_bench" in streams)
        assertTrue(streams.count { it == "obd_raw" } > 50)
        val discovery = JSONObject(sink.lines.first { it.first == "obd_discovery" }.second).getJSONObject("d")
        assertEquals("2HGFC2F5XGH000000", discovery.getJSONObject("vehicleInfo").getString("vin"))
        assertEquals(6, rec.summary.getJSONObject("benchmark").getInt("maxCompleteBatch"))
        // Nothing outside the read-only allowlist was ever sent.
        fake.received.forEach { ElmAllowlist.check(it) }
        val rpm = JSONObject(sink.lines.first { it.first == "obd:rpm" }.second)
        assertEquals(1726.0, rpm.getDouble("val"), 1e-9)
        assertEquals("rpm", rpm.getString("u"))
        assertEquals("1AF8", rpm.getString("data"))
        assertEquals("7E8", rpm.getString("ecu"))
        // The engine ECU's values feed the engine summary; values outside the summary list don't.
        assertEquals("7E8", discovery.getString("mainEcu"))
        assertTrue(sink.summarized.any { it.first == "obd:rpm" && it.second == 1726.0 })
        assertTrue(sink.summarized.none { it.first == "obd:o2_present" })
    }

    @Test
    fun benchmarkFindsMultiPidLimit() {
        val (rec, _) = runRecorder(FakeElm(maxMultiPid = 3)) { it.streams().contains("obd_bench") }
        assertEquals(3, rec.summary.getJSONObject("benchmark").getInt("maxCompleteBatch"))
    }

    @Test
    fun waitsWhileIgnitionOffThenRecovers() {
        val fake = FakeElm(vehicleOn = false)
        Thread {
            Thread.sleep(300)
            fake.vehicleOn = true
        }.start()
        val (_, sink) = runRecorder(fake) { s -> s.streams().contains("obd:speed") }
        assertTrue(sink.streams().contains("obd:speed"))
        assertFalse(fake.received.isEmpty())
    }

    @Test
    fun noDataAfterIgnitionOffIsVehicleLostNotDemotion() {
        // Like the Civic: once switched off, every request gets NO DATA.
        val fake = FakeElm(offReply = "NO DATA")
        var switchedOff = false
        var restarted = false
        val (_, sink) = runRecorder(fake) { s ->
            val streams = s.streams()
            if (!switchedOff && streams.count { it == "obd:rpm" } >= 20) {
                fake.vehicleOn = false
                switchedOff = true
            }
            val events = synchronized(s.lines) { s.lines.filter { it.first == "obd_event" }.map { JSONObject(it.second).getString("ev") } }
            if (switchedOff && !restarted && "vehicle_lost" in events) {
                fake.vehicleOn = true
                restarted = true
            }
            restarted && streams.count { it == "obd_discovery" } >= 2 && streams.count { it == "obd:rpm" } >= 40
        }
        val events = sink.lines.filter { it.first == "obd_event" }.map { JSONObject(it.second).getString("ev") }
        assertTrue("events: $events", "vehicle_lost" in events)
        assertTrue("events: $events", "pid_demoted" !in events)
        assertEquals(2, sink.streams().count { it == "obd_discovery" })
        assertTrue(sink.streams().count { it == "obd:rpm" } >= 40)
    }

    @Test
    fun allowlistTakesRequestHeadersOnly() {
        for (c in listOf("ATSH7E0", "ATSH7DF", "ATCP18", "ATSHDA10F1", "ATSHDB33F1")) ElmAllowlist.check(c)
        for (c in listOf("ATSH7E", "ATSHDA10F1FF", "ATCPX1")) {
            assertTrue(c, runCatching { ElmAllowlist.check(c) }.isFailure)
        }
    }

    @Test
    fun engineOnlyAddressingAndBackToAllEcusAfterIgnitionOff() {
        val fake = FakeElm(offReply = "NO DATA")
        var switchedOff = false
        var restarted = false
        val (_, sink) = runRecorder(fake, """{"engineOnly": "on"}""") { s ->
            val streams = s.streams()
            if (!switchedOff && streams.count { it == "obd:rpm" } >= 20) {
                fake.vehicleOn = false
                switchedOff = true
            }
            val events = synchronized(s.lines) { s.lines.filter { it.first == "obd_event" }.map { JSONObject(it.second).getString("ev") } }
            if (switchedOff && !restarted && "vehicle_lost" in events) {
                fake.vehicleOn = true
                restarted = true
            }
            restarted && streams.count { it == "obd_bench" } >= 2 && streams.count { it == "obd:rpm" } >= 40
        }
        val bench = JSONObject(sink.lines.first { it.first == "obd_bench" }.second).getJSONObject("b")
        assertEquals("engine_only", bench.getString("addressing"))
        // Engine-only header set after the first benchmark, reset to all ECUs before rediscovering.
        val sent = fake.received
        val firstPhysical = sent.indexOf("ATSH7E0")
        assertTrue("sent: $sent", firstPhysical >= 0)
        val secondDiscovery = sent.withIndex().filter { it.value == "0100" }.map { it.index }.getOrNull(1) ?: -1
        assertTrue("second discovery after switch-off", secondDiscovery > firstPhysical)
        assertTrue("ATSH7DF before rediscovery", sent.subList(firstPhysical, secondDiscovery).contains("ATSH7DF"))
        assertTrue(sink.streams().count { it == "obd:rpm" } >= 40)
    }

    @Test
    fun benchmarkRecordsWhichAddressingItChose() {
        val (_, sink) = runRecorder(FakeElm()) { it.streams().contains("obd_bench") }
        val bench = JSONObject(sink.lines.first { it.first == "obd_bench" }.second).getJSONObject("b")
        assertTrue(bench.getString("addressing") in setOf("engine_only", "all_ecus"))
        assertTrue(bench.has("engineOnly"))
    }

    @Test
    fun reconnectsAfterLinkDrop() {
        var connects = 0
        var current = FakeElm()
        val cfg = Config.parse(null).obd
        val sink = CollectSink()
        val rec = ObdRecorder(cfg, {
            connects++
            current = FakeElm()
            current
        }, sink, System::nanoTime, sleep = { Thread.sleep(minOf(it, 20)) })
        rec.start()
        while (sink.streams().count { it == "obd:rpm" } < 10) Thread.sleep(10)
        current.dropLink = true
        val deadline = System.currentTimeMillis() + 10_000
        while (connects < 2 && System.currentTimeMillis() < deadline) Thread.sleep(10)
        while (sink.streams().count { it == "obd_discovery" } < 2 && System.currentTimeMillis() < deadline) Thread.sleep(10)
        rec.stop()
        assertTrue(connects >= 2)
        assertTrue(sink.streams().contains("obd_event"))
        assertEquals(2, sink.streams().count { it == "obd_discovery" })
    }
}
