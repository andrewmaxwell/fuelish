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
    fun savedOldSensorDefaultsTakeTheTrimmedOnes() {
        // What a phone that saved settings before the Nov 2026 trim has stored.
        val saved = JSONObject("""{"sensors":{"acc":200,"gyro":200,"mag":50,"acc_unc":0,"gyro_unc":50,"mag_unc":50,"gravity":50,"linacc":100,"rotvec":100,"gamerot":50,"georot":0,"pressure":25,"light":0,"prox":0,"temp":0,"humidity":0,"heading":0},
            "location":{"gpsIntervalMs":100,"fusedIntervalMs":1000,"gnssStatus":true,"gnssMeasurements":true,"gnssFullTracking":false,"gnssNavigationMessages":false,"nmea":false}}""")
        val c = Config.parse(saved.toString())
        assertEquals(0.0, c.sensors["gyro"])
        assertEquals(0.0, c.sensors["rotvec"])
        assertEquals(200.0, c.sensors["acc"])
        assertEquals(50.0, c.sensorStoreHz["acc"])
        assertEquals(false, c.location.getBoolean("gnssMeasurements"))
        assertEquals(false, c.location.getBoolean("gnssStatus"))
    }

    @Test
    fun savedOldStopWaitsTakeTheShortOnes() {
        val c = Config.parse("""{"auto":{"enabled":true,"carAddress":"AA:BB:CC:DD:EE:FF","stopAfterCarDisconnectS":120,"stopAfterEngineOffS":300}}""")
        assertEquals(10, c.auto.getInt("stopAfterCarDisconnectS"))
        assertEquals(60, c.auto.getInt("stopAfterEngineOffS"))
        assertEquals("AA:BB:CC:DD:EE:FF", c.auto.getString("carAddress"))
        assertEquals(30, Config.parse("""{"auto":{"stopAfterCarDisconnectS":30}}""").auto.getInt("stopAfterCarDisconnectS"))
    }

    @Test
    fun mobileDataUploadsAreOnAndTheOldOffSettingIsDropped() {
        assertEquals(true, Config.parse(null).upload.getBoolean("mobileData"))
        // Every phone that saved settings before has the old key stored as false.
        val c = Config.parse("""{"upload":{"enabled":true,"allowCellular":false,"deleteAfterUpload":true}}""")
        assertEquals(true, c.upload.getBoolean("mobileData"))
        assertEquals(false, c.upload.has("allowCellular"))
        // Turning it off in Settings stays off.
        assertEquals(false, Config.parse("""{"upload":{"mobileData":false}}""").upload.getBoolean("mobileData"))
    }

    @Test
    fun editedSensorRatesStay() {
        val c = Config.parse("""{"sensors":{"gyro":100},"location":{"gnssMeasurements":true}}""")
        assertEquals(100.0, c.sensors["gyro"])
        assertEquals(true, c.location.getBoolean("gnssMeasurements"))
        assertEquals(true, refused("""{"sensorStoreHz":{"acc":"half"}}""") != null)
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
