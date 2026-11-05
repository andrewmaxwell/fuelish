package app.fuelish.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AutoStopPolicyTest {
    private val s = 1_000_000_000L
    private fun policy() = AutoStopPolicy(10 * s, 60 * s)

    @Test
    fun stopsSoonAfterCarDisconnectsOnceTheEngineIsOff() {
        val p = policy()
        assertNull(p.check(0, "polling"))
        p.carEvent(false, 10 * s)
        assertNull(p.check(11 * s, "discovering")) // vehicle_lost just came in
        assertNull(p.check(19 * s, "waiting_vehicle"))
        assertEquals("car_disconnected", p.check(20 * s, "waiting_vehicle"))
        assertEquals(10 * s, p.driveEndNs("car_disconnected"))
    }

    @Test
    fun bluetoothDropWhileTheEngineAnswersDoesNotStop() {
        val p = policy()
        p.carEvent(false, 10 * s)
        assertNull(p.check(500 * s, "polling"))
        // Reconnecting cancels it; a later disconnect starts a fresh window.
        p.carEvent(true, 600 * s)
        assertNull(p.check(700 * s, "polling"))
        p.carEvent(false, 800 * s)
        assertNull(p.check(805 * s, "waiting_vehicle"))
        assertEquals("car_disconnected", p.check(810 * s, "waiting_vehicle"))
    }

    @Test
    fun withoutAnAdapterTheBluetoothWaitDecides() {
        val p = policy()
        p.carEvent(false, 0)
        assertNull(p.check(9 * s, "off"))
        assertEquals("car_disconnected", p.check(10 * s, "off"))
    }

    @Test
    fun engineOffStopsEvenIfCarBluetoothStaysOn() {
        val p = policy()
        assertNull(p.check(0, "polling"))
        assertNull(p.check(10 * s, "waiting_vehicle"))
        // Adapter goes to sleep after the car is off: the clock keeps running.
        assertNull(p.check(30 * s, "connecting"))
        assertNull(p.check(69 * s, "disconnected"))
        assertEquals("engine_off", p.check(70 * s, "disconnected"))
    }

    @Test
    fun carAnsweringAgainResetsEngineOff() {
        val p = policy()
        p.check(0, "waiting_vehicle")
        p.check(50 * s, "polling")
        assertNull(p.check(100 * s, "waiting_vehicle"))
        assertEquals("engine_off", p.check(160 * s, "waiting_vehicle"))
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
