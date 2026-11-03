package app.fuelish.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AutoStopPolicyTest {
    private val s = 1_000_000_000L
    private fun policy() = AutoStopPolicy(120 * s, 300 * s)

    @Test
    fun stopsTwoMinutesAfterCarDisconnects() {
        val p = policy()
        assertNull(p.check(0, "polling"))
        p.carEvent(false, 10 * s)
        assertNull(p.check(129 * s, "polling"))
        assertEquals("car_disconnected", p.check(130 * s, "polling"))
    }

    @Test
    fun briefBluetoothDropDoesNotStop() {
        val p = policy()
        p.carEvent(false, 10 * s)
        p.carEvent(true, 40 * s)
        assertNull(p.check(500 * s, "polling"))
        // A later disconnect starts a fresh window.
        p.carEvent(false, 600 * s)
        assertNull(p.check(700 * s, "polling"))
        assertEquals("car_disconnected", p.check(720 * s, "polling"))
    }

    @Test
    fun engineOffStopsEvenIfCarBluetoothStaysOn() {
        val p = policy()
        assertNull(p.check(0, "polling"))
        assertNull(p.check(10 * s, "waiting_vehicle"))
        // Adapter goes to sleep after the car is off: the clock keeps running.
        assertNull(p.check(100 * s, "connecting"))
        assertNull(p.check(309 * s, "disconnected"))
        assertEquals("engine_off", p.check(310 * s, "disconnected"))
    }

    @Test
    fun carAnsweringAgainResetsEngineOff() {
        val p = policy()
        p.check(0, "waiting_vehicle")
        p.check(200 * s, "polling")
        assertNull(p.check(400 * s, "waiting_vehicle"))
        assertEquals("engine_off", p.check(700 * s, "waiting_vehicle"))
    }

    @Test
    fun adapterTroubleAloneNeverStops() {
        val p = policy()
        p.check(0, "polling")
        assertNull(p.check(10_000 * s, "disconnected"))
        assertNull(p.check(20_000 * s, "connecting"))
    }

    @Test
    fun zeroDisablesRules() {
        val p = AutoStopPolicy(0, 0)
        p.carEvent(false, 0)
        p.check(0, "waiting_vehicle")
        assertNull(p.check(100_000 * s, "waiting_vehicle"))
    }
}
