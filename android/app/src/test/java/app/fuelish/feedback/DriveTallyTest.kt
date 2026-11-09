package app.fuelish.feedback

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DriveTallyTest {
    @Test fun milesCountOnlyWhileMovingWithAGoodFix() {
        val t = DriveTally()
        t.gps(40.0, -105.0, 5.0, 0.0)
        t.gps(40.0001, -105.0, 5.0, 0.0) // parked jitter
        t.gps(40.0101, -105.0, 5.0, 20.0) // ~1.11 km driven
        t.gps(40.5, -105.0, 200.0, 20.0) // a wild fix
        assertEquals(1.11, t.meters / 1000, 0.01)
        assertEquals(40.0, t.startLat, 0.0)
    }

    @Test fun fuelFromTheCarsRateOrFromAirflow() {
        assertEquals(745.0 / 3600, DriveTally.fuelGs(mapOf("fuel_rate" to 1.0))!!, 1e-9)
        assertEquals(14.08 / 14.08, DriveTally.fuelGs(mapOf("maf" to 14.08, "commanded_lambda" to 1.0))!!, 1e-9)
        assertEquals(0.0, DriveTally.fuelGs(mapOf("maf" to 5.0, "commanded_lambda" to 1.999))!!, 0.0)
        assertNull(DriveTally.fuelGs(mapOf("rpm" to 800.0)))
    }

    @Test fun gallonsNeedEnoughEngineData() {
        val t = DriveTally()
        t.engine(10.0, mapOf("fuel_rate" to 3.0))
        assertNull(t.gallons)
        t.engine(3590.0, mapOf("fuel_rate" to 3.0))
        assertEquals(3.0 / 3.78541, t.gallons!!, 1e-6) // an hour at 3 L/h
    }

    @Test fun theSummarySaysWhatItKnows() {
        assertEquals(
            "Drive saved. 14.2 miles in 23 minutes. 0.41 gallons, 35 miles per gallon, about $1.40 of gas.",
            DriveTally.summary(14.2, 23.2, 0.41, 3.41),
        )
        assertEquals("Drive saved. 3.0 miles in 1 hour 5 minutes.", DriveTally.summary(3.0, 65.0, null, 3.0))
        assertEquals(
            "Drive saved. 2.0 miles in 6 minutes. 0.08 gallons, 25 miles per gallon, about 26 cents of gas.",
            DriveTally.summary(2.0, 6.0, 0.08, 3.25),
        )
        assertNull(DriveTally.summary(0.1, 2.0, 0.01, 3.0))
    }

    @Test fun gasRegionAndLatestPrice() {
        assertEquals("rockies", GasPrice.region(39.74, -104.99)) // Denver
        assertEquals("west", GasPrice.region(34.05, -118.24))
        assertEquals("us", GasPrice.region(Double.NaN, Double.NaN))
        val body = JSONObject("""{"regions":{"rockies":{"weeks":[[1,3.1],[2,3.25]]},"us":{"weeks":[]}}}""")
        val latest = GasPrice.latestByRegion(body)
        assertEquals(3.25, latest.getDouble("rockies"), 0.0)
        assertEquals(false, latest.has("us"))
    }
}
