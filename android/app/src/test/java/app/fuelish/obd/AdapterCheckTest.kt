package app.fuelish.obd

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdapterCheckTest {
    @Test
    fun `a running car with an airflow sensor passes`() {
        val r = AdapterCheck.run(FakeElm())
        assertTrue(r.ok)
        assertEquals("2HGFC2F5XGH000000", r.vin)
        assertEquals(AdapterCheck.Fuel.AIRFLOW, r.fuel)
        assertEquals("OBDLink MX+ r1.2", r.adapterName)
    }

    @Test
    fun `a car that reports its fuel rate says so`() {
        val r = AdapterCheck.run(FakeElm(supported = setOf(0x0C, 0x0D, 0x10, 0x5E)))
        assertEquals(AdapterCheck.Fuel.REPORTED, r.fuel)
    }

    @Test
    fun `no airflow and no fuel rate means no fuel numbers, but the adapter still works`() {
        val r = AdapterCheck.run(FakeElm(supported = setOf(0x0C, 0x0D)))
        assertTrue(r.ok)
        assertEquals(AdapterCheck.Fuel.NONE, r.fuel)
    }

    @Test
    fun `a car that's off fails with what to do`() {
        val r = AdapterCheck.run(FakeElm(vehicleOn = false))
        assertTrue(r.adapterOk)
        assertFalse(r.carOk)
        assertFalse(r.ok)
        assertTrue(r.problem.contains("Turn the car on"))
    }
}
