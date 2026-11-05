package app.fuelish

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class ConfigTest {
    private fun list(c: Config, k: String) = c.obd.getJSONArray(k).let { a -> (0 until a.length()).map { a.getString(it) } }

    @Test
    fun savedOldDefaultListsTakeTheNewDefaults() {
        // What a phone that saved settings before the change has stored: the whole old obd block.
        val saved = JSONObject().put("obd", JSONObject()
            .put("fast", org.json.JSONArray(listOf("0C", "0D", "10", "0B", "11", "04", "49", "5A", "45", "43")))
            .put("medium", org.json.JSONArray(listOf("0E", "06", "07", "44", "34", "24", "14", "15", "4C", "61", "62", "5E", "0F", "47")))
            .put("deviceAddress", "00:04:3E:8D:02:0A"))
        val c = Config.parse(saved.toString())
        assertEquals(true, "44" in list(c, "fast"))
        assertEquals(true, "45" in list(c, "medium"))
        assertEquals("00:04:3E:8D:02:0A", c.obd.getString("deviceAddress"))
    }

    @Test
    fun editedListsStayAsTheUserSetThem() {
        val saved = JSONObject().put("obd", JSONObject().put("fast", org.json.JSONArray(listOf("0C", "0D"))))
        assertEquals(listOf("0C", "0D"), list(Config.parse(saved.toString()), "fast"))
    }

    private fun refused(json: String): String? = runCatching { Config.parseChecked(json) }.exceptionOrNull()?.message

    @Test
    fun defaultsAndOrdinaryEditsPassTheChecks() {
        assertEquals(null, refused("{}"))
        assertEquals(null, refused("""{"obd":{"deviceAddress":"00:04:3E:8D:02:0A","fast":["0c","0D"]},"auto":{"enabled":true,"carAddress":"AA:BB:CC:DD:EE:FF"}}"""))
    }

    @Test
    fun refusesConfigsTheRecorderCantUse() {
        // The review's case: parse used to accept it, then reading obd threw.
        assertEquals(true, refused("""{"obd":null}""")!!.contains("obd must be an object"))
        assertEquals(true, refused("""{"location":[]}""") != null)
        assertEquals(true, refused("""{"upload":{"enabled":"yes"}}""")!!.contains("upload.enabled"))
        assertEquals(true, refused("""{"chunkSeconds":0}""") != null)
        assertEquals(true, refused("""{"sensors":{"acc":"fast"}}""") != null)
        assertEquals(true, refused("""{"obd":{"fast":["0C","rpm"]}}""") != null)
        assertEquals(true, refused("""{"obd":{"deviceAddress":"my obd"}}""") != null)
        assertEquals(true, refused("""{"obd":{"engineOnly":"maybe"}}""") != null)
    }
}
