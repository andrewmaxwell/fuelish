package app.fuelish.feedback

import app.fuelish.feedback.DriveWatch.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DriveWatchTest {
    private val s = 1_000_000_000L
    private val none = emptyMap<String, Double>()

    private fun kinds(w: DriveWatch, t: Long, state: String, v: Map<String, Double> = none, volts: Double? = null, moving: Boolean = true) =
        w.tick(t * s, state, v, volts, moving).map { it.kind }

    @Test fun anAdapterThatNeverAnswersIsSaidOnceWhileMoving() {
        val w = DriveWatch(expectAdapter = true, milWasOn = false)
        assertEquals(emptyList<Kind>(), kinds(w, 0, "connecting"))
        assertEquals(emptyList<Kind>(), kinds(w, 95, "connecting", moving = false)) // parked: not yet
        assertEquals(listOf(Kind.ADAPTER_NOT_CONNECTING), kinds(w, 96, "disconnected"))
        assertEquals(emptyList<Kind>(), kinds(w, 200, "connecting"))
    }

    @Test fun aLongIdleIsMentionedOnceWithWhatItBurned() {
        val w = DriveWatch(expectAdapter = true, milWasOn = false)
        val idling = mapOf("speed" to 0.0, "rpm" to 700.0, "fuel_rate" to 1.0) // 1 L/h
        for (t in 0L until 180) assertEquals(emptyList<Kind>(), kinds(w, t, "polling", idling, moving = false))
        val cue = w.tick(180 * s, "polling", idling, null, false).single()
        assertEquals(Kind.LONG_IDLE, cue.kind)
        assertEquals(0.05 / 3.78541, cue.value!!, 1e-4) // 3 min at 1 L/h
        assertEquals(
            "The engine has idled for 3 minutes, about 4 cents of gas so far. Switching off saves gas on a longer wait.",
            DriveWatch.words(cue, 3.0),
        )
        assertEquals("The engine has idled for 3 minutes. Switching off saves gas on a longer wait.", DriveWatch.words(cue))
        // Not again on this drive, however long the next wait.
        kinds(w, 200, "polling", mapOf("speed" to 40.0, "rpm" to 1800.0))
        for (t in 300L..700) assertEquals(emptyList<Kind>(), kinds(w, t, "polling", idling, moving = false))
    }

    @Test fun aRedLightIsNotALongIdle() {
        val w = DriveWatch(expectAdapter = true, milWasOn = false)
        val idling = mapOf("speed" to 0.0, "rpm" to 700.0)
        for (t in 0L..120) kinds(w, t, "polling", idling, moving = false)
        kinds(w, 121, "polling", mapOf("speed" to 30.0, "rpm" to 1500.0))
        for (t in 122L..250) assertEquals(emptyList<Kind>(), kinds(w, t, "polling", idling, moving = false))
    }

    @Test fun noAdapterExpectedMeansNoWarning() {
        val w = DriveWatch(expectAdapter = false, milWasOn = false)
        kinds(w, 0, "connecting")
        assertEquals(emptyList<Kind>(), kinds(w, 500, "connecting"))
    }

    @Test fun aDropMidDriveIsSaidAndSoIsTheReturn() {
        val w = DriveWatch(expectAdapter = true, milWasOn = false)
        kinds(w, 0, "polling")
        kinds(w, 10, "polling")
        assertEquals(emptyList<Kind>(), kinds(w, 29, "connecting"))
        assertEquals(listOf(Kind.ADAPTER_LOST), kinds(w, 30, "disconnected"))
        assertEquals(emptyList<Kind>(), kinds(w, 60, "connecting"))
        assertEquals(listOf(Kind.ADAPTER_BACK), kinds(w, 70, "polling"))
    }

    @Test fun switchingTheCarOffIsNotADrop() {
        val w = DriveWatch(expectAdapter = true, milWasOn = false)
        kinds(w, 0, "polling")
        kinds(w, 5, "waiting_vehicle") // the car stopped answering, then the adapter went to sleep
        assertEquals(emptyList<Kind>(), kinds(w, 60, "disconnected"))
    }

    @Test fun theCheckEngineLightIsSaidWhenItComesOnNotWhileItStaysOn() {
        val w = DriveWatch(expectAdapter = true, milWasOn = false)
        assertEquals(emptyList<Kind>(), kinds(w, 0, "polling", mapOf("mil_on" to 0.0)))
        assertEquals(listOf(Kind.CHECK_ENGINE), kinds(w, 1, "polling", mapOf("mil_on" to 1.0)))
        assertEquals(emptyList<Kind>(), kinds(w, 2, "polling", mapOf("mil_on" to 1.0)))
        assertTrue(w.milOn)
        val next = DriveWatch(expectAdapter = true, milWasOn = true)
        assertEquals(emptyList<Kind>(), kinds(next, 0, "polling", mapOf("mil_on" to 1.0)))
    }

    @Test fun aHotEngineIsSaidAfterThirtySecondsAndAgainOnlyAfterCooling() {
        val w = DriveWatch(expectAdapter = true, milWasOn = false)
        val hot = mapOf("coolant_temp" to 115.0)
        kinds(w, 0, "polling", hot)
        assertEquals(emptyList<Kind>(), kinds(w, 29, "polling", hot))
        val said = w.tick(30 * s, "polling", hot, null, true)
        assertEquals(listOf(Kind.ENGINE_HOT), said.map { it.kind })
        assertEquals("The engine is running hot, 239 degrees.", DriveWatch.words(said[0]))
        assertEquals(emptyList<Kind>(), kinds(w, 100, "polling", hot))
        kinds(w, 101, "polling", mapOf("coolant_temp" to 100.0))
        kinds(w, 102, "polling", hot)
        assertEquals(listOf(Kind.ENGINE_HOT), kinds(w, 132, "polling", hot))
    }

    @Test fun lowVoltageCountsOnlyWithTheEngineRunning() {
        val w = DriveWatch(expectAdapter = true, milWasOn = false)
        val off = mapOf("rpm" to 0.0, "module_voltage" to 11.5)
        kinds(w, 0, "polling", off)
        assertEquals(emptyList<Kind>(), kinds(w, 100, "polling", off))
        val running = mapOf("rpm" to 800.0)
        kinds(w, 101, "polling", running, volts = 11.8)
        assertEquals(emptyList<Kind>(), kinds(w, 160, "polling", running, volts = 11.8))
        assertEquals(listOf(Kind.NOT_CHARGING), kinds(w, 161, "polling", running, volts = 11.8))
    }

    @Test fun staleValuesFromADroppedLinkAreIgnored() {
        val w = DriveWatch(expectAdapter = true, milWasOn = false)
        kinds(w, 0, "polling", mapOf("mil_on" to 0.0))
        assertFalse(kinds(w, 1, "connecting", mapOf("mil_on" to 1.0)).contains(Kind.CHECK_ENGINE))
    }

    @Test fun adapterVoltsParse() {
        assertEquals(14.2, DriveWatch.parseVolts("14.2V")!!, 1e-9)
        assertEquals(null, DriveWatch.parseVolts("?"))
    }
}
