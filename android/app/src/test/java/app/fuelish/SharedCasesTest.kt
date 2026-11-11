package app.fuelish

import app.fuelish.feedback.DriveTally
import app.fuelish.feedback.GasPrice
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/**
 * Rules the phone has its own copy of, checked against shared/cases.json, which the web page's and
 * the server's tests check too: a rule changed in one copy only fails a test.
 */
class SharedCasesTest {
    private val cases = JSONObject(
        generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, "shared/cases.json") }.first { it.exists() }.readText(),
    )

    @Test fun gasRegionsMatchTheWebPage() {
        val a = cases.getJSONArray("gasRegion")
        for (i in 0 until a.length()) {
            val c = a.getJSONArray(i)
            assertEquals("${c.getDouble(0)}, ${c.getDouble(1)}", c.getString(2), GasPrice.region(c.getDouble(0), c.getDouble(1)))
        }
    }

    @Test fun distanceMatchesTheWebPage() {
        val a = cases.getJSONArray("haversine")
        for (i in 0 until a.length()) {
            val c = a.getJSONArray(i)
            assertEquals(c.getDouble(4), DriveTally.distanceM(c.getDouble(0), c.getDouble(1), c.getDouble(2), c.getDouble(3)), 0.01)
        }
    }

    @Test fun fuelFromTheEngineMatchesTheWebPage() {
        val a = cases.getJSONArray("fuelGs")
        for (i in 0 until a.length()) {
            val c = a.getJSONArray(i)
            val v = c.getJSONObject(0)
            val values = v.keys().asSequence().associateWith { v.getDouble(it) }
            if (c.isNull(1)) assertNull(DriveTally.fuelGs(values)) else assertEquals(v.toString(), c.getDouble(1), DriveTally.fuelGs(values)!!, 1e-6)
        }
    }
}
