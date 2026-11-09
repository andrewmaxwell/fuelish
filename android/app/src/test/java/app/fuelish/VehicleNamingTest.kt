package app.fuelish

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VehicleNamingTest {
    private val vin = "2HGFE2F59NH512345"

    @Test fun unnamedTripInThatCarAwaitsItsName() {
        val meta = JSONObject().put("status", "stopped").put("vehicle", "").put("vehicleVin", vin)
        assertTrue(VehicleNaming.awaits(meta, vin.lowercase()))
    }

    @Test fun namedTripsRecordingsAndOtherCarsDont() {
        assertFalse(VehicleNaming.awaits(JSONObject().put("status", "stopped").put("vehicle", "2022 Honda Civic").put("vehicleVin", vin), vin))
        assertFalse(VehicleNaming.awaits(JSONObject().put("status", "recording").put("vehicle", "").put("vehicleVin", vin), vin))
        assertFalse(VehicleNaming.awaits(JSONObject().put("status", "stopped").put("vehicle", "").put("vehicleVin", "1FTFW1E50NFA00001"), vin))
    }

    @Test fun olderTripsMatchOnTheSummaryVin() {
        val summary = JSONObject().put("obd", JSONObject().put("discovery", JSONObject().put("vehicleInfo", JSONObject().put("vin", vin))))
        assertTrue(VehicleNaming.awaits(JSONObject().put("status", "stopped").put("summary", summary), vin))
    }
}
