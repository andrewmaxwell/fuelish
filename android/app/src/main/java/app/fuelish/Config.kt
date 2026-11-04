package app.fuelish

import org.json.JSONArray
import org.json.JSONObject

/**
 * Recorder configuration, stored as JSON so new knobs never need a migration. The user's
 * JSON is deep-merged over [DEFAULTS]; the merged result is copied into every recording's
 * metadata so the data can always be interpreted with the settings that produced it.
 */
class Config(val json: JSONObject) {
    val serverUrl get() = json.optString("serverUrl").trimEnd('/')
    val deviceToken get() = json.optString("deviceToken")
    val vehicle get() = json.optString("vehicle")

    val chunkSeconds get() = json.optInt("chunkSeconds", 60)
    val chunkMaxBytes get() = json.optLong("chunkMaxBytes", 32L shl 20)

    /** Sensor key -> requested rate in Hz (0 = off, -1 = fastest the device allows). */
    val sensors: Map<String, Double>
        get() = json.optJSONObject("sensors")?.let { o -> o.keys().asSequence().associateWith { o.getDouble(it) } } ?: emptyMap()
    val sensorMaxLatencyMs get() = json.optInt("sensorMaxReportLatencyMs", 200)

    val location get() = json.getJSONObject("location")
    val obd get() = json.getJSONObject("obd")
    val upload get() = json.getJSONObject("upload")
    val auto get() = json.getJSONObject("auto")
    val batteryIntervalS get() = json.optInt("batteryIntervalS", 10)

    fun redacted(): JSONObject = JSONObject(json.toString()).apply { if (has("deviceToken")) put("deviceToken", "<redacted>") }

    companion object {
        val DEFAULTS: String = """
        {
          "vehicle": "2016 Honda Civic LX 2.0L",
          "serverUrl": "",
          "deviceToken": "",
          "chunkSeconds": 60,
          "chunkMaxBytes": 33554432,
          "sensors": {
            "acc": 200, "gyro": 200, "mag": 50,
            "acc_unc": 0, "gyro_unc": 50, "mag_unc": 50,
            "gravity": 50, "linacc": 100,
            "rotvec": 100, "gamerot": 50, "georot": 0,
            "pressure": 25, "light": 0, "prox": 0, "temp": 0, "humidity": 0, "heading": 0
          },
          "sensorMaxReportLatencyMs": 200,
          "location": {
            "gpsIntervalMs": 100,
            "fusedIntervalMs": 1000,
            "gnssStatus": true,
            "gnssMeasurements": true,
            "gnssFullTracking": false,
            "gnssNavigationMessages": false,
            "nmea": false
          },
          "batteryIntervalS": 10,
          "obd": {
            "enabled": true,
            "deviceAddress": "",
            "deviceName": "",
            "protocol": "0",
            "fastIntervalMs": 0,
            "mediumIntervalMs": 500,
            "slowIntervalMs": 5000,
            "otherIntervalMs": 10000,
            "fast": ["0C", "0D", "10", "0B", "11", "04", "49", "5A", "45", "43"],
            "medium": ["0E", "06", "07", "44", "34", "24", "14", "15", "4C", "61", "62", "5E", "0F", "47"],
            "slow": ["05", "2F", "33", "46", "42", "5C", "3C", "1F", "01", "03", "31", "21", "4D", "4E", "A6", "13", "1C", "51", "63"],
            "maxPidsPerRequest": 0,
            "demoteAfterMisses": 5,
            "vehicleLostAfterSilent": 5,
            "demotedIntervalMs": 30000,
            "adapterVoltageIntervalMs": 5000,
            "readVehicleInfo": true,
            "readDtcs": true,
            "benchmark": true,
            "requestTimeoutMs": 2000
          },
          "upload": {
            "enabled": true,
            "allowCellular": false,
            "deleteAfterUpload": true
          },
          "auto": {
            "enabled": false,
            "carAddress": "",
            "carName": "",
            "stopAfterCarDisconnectS": 120,
            "stopAfterEngineOffS": 300
          }
        }
        """.trimIndent()

        fun parse(userJson: String?): Config {
            val base = JSONObject(DEFAULTS)
            if (!userJson.isNullOrBlank()) merge(base, JSONObject(userJson))
            return Config(base)
        }

        fun merge(into: JSONObject, from: JSONObject) {
            for (k in from.keys()) {
                val v = from.get(k)
                val existing = into.opt(k)
                if (v is JSONObject && existing is JSONObject) merge(existing, v) else into.put(k, v)
            }
        }

        fun hexList(a: JSONArray?): List<Int> =
            if (a == null) emptyList() else (0 until a.length()).map { a.getString(it).toInt(16) }
    }
}
