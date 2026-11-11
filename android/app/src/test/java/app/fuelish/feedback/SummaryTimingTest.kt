package app.fuelish.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SummaryTimingTest {
    private val s = 1_000_000_000L

    @Test fun saidOnceWhenTheCarIsSwitchedOff() {
        val t = SummaryTiming()
        assertFalse(t.tick(0, "polling", true, true, 0.0))
        assertFalse(t.tick(600 * s, "waiting_vehicle", true, false, 5.0)) // just went quiet
        assertFalse(t.tick(602 * s, "waiting_vehicle", true, false, 5.0))
        assertTrue(t.tick(603 * s, "waiting_vehicle", true, false, 5.0))
        assertEquals(600 * s, t.quietSince)
        assertFalse(t.tick(604 * s, "disconnected", true, false, 5.0)) // the adapter went to sleep
        assertFalse(t.atStop(5.0)) // the recording ends a minute later: already said
    }

    @Test fun aDroppedLinkAtARedLightIsNotTheEnd() {
        val t = SummaryTiming()
        t.tick(0, "polling", true, true, 0.0)
        assertFalse(t.tick(100 * s, "disconnected", true, false, 2.0))
        assertFalse(t.tick(200 * s, "connecting", true, false, 2.0))
        assertTrue(t.atStop(6.0))
    }

    @Test fun theCarsBluetoothGoingCountsOnceTheEngineIsQuiet() {
        val t = SummaryTiming()
        t.tick(0, "polling", true, true, 0.0)
        assertFalse(t.tick(100 * s, "polling", false, false, 2.0)) // a Bluetooth glitch, engine running
        assertFalse(t.tick(101 * s, "disconnected", false, true, 2.0)) // still rolling
        assertTrue(t.tick(105 * s, "disconnected", false, false, 2.0))
    }

    @Test fun saidAgainOnlyAfterDrivingOn() {
        val t = SummaryTiming()
        t.tick(0, "polling", true, true, 0.0)
        t.tick(100 * s, "waiting_vehicle", true, false, 3.0)
        assertTrue(t.tick(104 * s, "waiting_vehicle", true, false, 3.0)) // stopped for gas
        t.tick(300 * s, "polling", true, true, 3.0)
        t.tick(900 * s, "waiting_vehicle", true, false, 9.0)
        assertTrue(t.tick(904 * s, "waiting_vehicle", true, false, 9.0))
        assertFalse(t.atStop(9.0))
    }

    @Test fun withoutAnEngineItWaitsForTheEnd() {
        val t = SummaryTiming()
        assertFalse(t.tick(500 * s, "off", true, false, 4.0))
        assertTrue(t.atStop(4.0))
    }
}
