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
    /** The VIN [vehicle] was named from; empty when someone typed the name (then a VIN never renames it). */
    val vehicleVin get() = json.optString("vehicleVin")

    val chunkSeconds get() = json.optInt("chunkSeconds", 60)
    val chunkMaxBytes get() = json.optLong("chunkMaxBytes", 32L shl 20)

    /** Sensor key -> requested rate in Hz (0 = off, -1 = fastest the device allows). */
    val sensors: Map<String, Double>
        get() = json.optJSONObject("sensors")?.let { o -> o.keys().asSequence().associateWith { o.getDouble(it) } } ?: emptyMap()
    /** Sensor key -> highest rate written to the recording (absent or 0 = every sample). The sensor still
     *  runs at its [sensors] rate for on-phone measures like jolt; only every Nth sample is stored. */
    val sensorStoreHz: Map<String, Double>
        get() = json.optJSONObject("sensorStoreHz")?.let { o -> o.keys().asSequence().associateWith { o.optDouble(it, 0.0) } } ?: emptyMap()
    val sensorMaxLatencyMs get() = json.optInt("sensorMaxReportLatencyMs", 200)

    val location get() = json.getJSONObject("location")
    val obd get() = json.getJSONObject("obd")
    val upload get() = json.getJSONObject("upload")
    val auto get() = json.getJSONObject("auto")
    /** What the phone says or plays during a drive: `sounds` (recording started, adapter trouble), `summary`, `warnings`, `tips` (a long idle). */
    val feedback get() = json.getJSONObject("feedback")
    val batteryIntervalS get() = json.optInt("batteryIntervalS", 10)

    fun redacted(): JSONObject = JSONObject(json.toString()).apply { if (has("deviceToken")) put("deviceToken", "<redacted>") }

    companion object {
        val DEFAULTS: String = """
        {
          "vehicle": "",
          "vehicleVin": "",
          "serverUrl": "https://fuelish.andrewmaxwell.dev",
          "deviceToken": "",
          "chunkSeconds": 60,
          "chunkMaxBytes": 33554432,
          "sensors": {
            "acc": 200, "gyro": 0, "mag": 0,
            "acc_unc": 0, "gyro_unc": 0, "mag_unc": 0,
            "gravity": 0, "linacc": 0,
            "rotvec": 0, "gamerot": 0, "georot": 0,
            "pressure": 5, "light": 0, "prox": 0, "temp": 0, "humidity": 0, "heading": 0
          },
          "sensorStoreHz": { "acc": 50 },
          "sensorMaxReportLatencyMs": 200,
          "location": {
            "gpsIntervalMs": 100,
            "fusedIntervalMs": 1000,
            "gnssStatus": false,
            "gnssMeasurements": false,
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
            "fast": ["0C", "0D", "10", "0B", "11", "04", "49", "5A", "44"],
            "medium": ["0E", "06", "07", "45", "43", "34", "24", "14", "15", "4C", "61", "62", "5E", "0F", "47"],
            "slow": ["05", "2F", "33", "46", "42", "5C", "3C", "1F", "01", "03", "31", "21", "4D", "4E", "A6", "13", "1C", "51", "63"],
            "maxPidsPerRequest": 0,
            "engineOnly": "auto",
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
            "mobileData": true,
            "deleteAfterUpload": true
          },
          "auto": {
            "enabled": false,
            "carAddress": "",
            "carName": "",
            "stopAfterCarDisconnectS": 10,
            "stopAfterEngineOffS": 60,
            "adapterWaitS": 120
          },
          "feedback": {
            "sounds": true,
            "summary": true,
            "warnings": true,
            "tips": true
          }
        }
        """.trimIndent()

        /**
         * Earlier default OBD lists. Saving settings stores the whole merged config, so a phone keeps
         * an old default list forever; a stored list still exactly equal to an old default is treated
         * as "never edited" and takes the current default. A list the user changed is left alone.
         */
        private val OLD_OBD_DEFAULTS = mapOf(
            "fast" to listOf(listOf("0C", "0D", "10", "0B", "11", "04", "49", "5A", "45", "43")),
            "medium" to listOf(listOf("0E", "06", "07", "44", "34", "24", "14", "15", "4C", "61", "62", "5E", "0F", "47")),
        )

        /**
         * Earlier sensor and location defaults (Nov 2026 and before: every motion sensor at 50–200 Hz and raw
         * GNSS, ~1.8 MB a driving minute, ~75% of it never read). A stored block still exactly equal to the
         * old default is treated as "never edited" and takes the current default.
         */
        private const val OLD_SENSORS_DEFAULT = """{"acc":200,"gyro":200,"mag":50,"acc_unc":0,"gyro_unc":50,"mag_unc":50,"gravity":50,"linacc":100,"rotvec":100,"gamerot":50,"georot":0,"pressure":25,"light":0,"prox":0,"temp":0,"humidity":0,"heading":0}"""
        private const val OLD_LOCATION_DEFAULT = """{"gpsIntervalMs":100,"fusedIntervalMs":1000,"gnssStatus":true,"gnssMeasurements":true,"gnssFullTracking":false,"gnssNavigationMessages":false,"nmea":false}"""

        private fun sameJson(a: JSONObject, b: JSONObject): Boolean =
            a.length() == b.length() && a.keys().asSequence().all { k ->
                val x = a.opt(k); val y = b.opt(k)
                if (x is Number && y is Number) x.toDouble() == y.toDouble() else x == y
            }

        fun parse(userJson: String?): Config {
            val base = JSONObject(DEFAULTS)
            if (!userJson.isNullOrBlank()) merge(base, upgrade(JSONObject(userJson)))
            return Config(base)
        }

        /** [parse], refusing a config the recorder can't run with (see [problems]). */
        fun parseChecked(userJson: String?): Config {
            val c = parse(userJson)
            val p = problems(c.json)
            require(p.isEmpty()) { p.joinToString("; ") }
            return c
        }

        private val HEX_PID = Regex("^[0-9A-Fa-f]{2}$")
        private val BT_ADDRESS = Regex("^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$")

        /**
         * What's wrong with a merged config, in words; empty when the recorder can use it. Every
         * setting that has a default must keep that default's kind (object, list, text, number,
         * yes/no), and numbers must be in a range the recorder can work with.
         */
        fun problems(merged: JSONObject): List<String> {
            val out = mutableListOf<String>()
            sameKinds(JSONObject(DEFAULTS), merged, "", out)
            if (out.isNotEmpty()) return out
            fun num(o: JSONObject, k: String, path: String, min: Double, max: Double) {
                val v = o.optDouble(k)
                if (v.isNaN() || v < min || v > max) out += "$path$k must be between ${fmt(min)} and ${fmt(max)}"
            }
            num(merged, "chunkSeconds", "", 5.0, 3600.0)
            num(merged, "chunkMaxBytes", "", 65536.0, 64.0 * 1024 * 1024) // the server takes up to 90 MB
            num(merged, "sensorMaxReportLatencyMs", "", 0.0, 60_000.0)
            num(merged, "batteryIntervalS", "", 1.0, 3600.0)
            val sensors = merged.getJSONObject("sensors")
            for (k in sensors.keys()) {
                if (sensors.opt(k) !is Number) out += "sensors.$k must be a number" else num(sensors, k, "sensors.", -1.0, 1000.0)
            }
            val store = merged.getJSONObject("sensorStoreHz")
            for (k in store.keys()) {
                if (store.opt(k) !is Number) out += "sensorStoreHz.$k must be a number" else num(store, k, "sensorStoreHz.", 0.0, 1000.0)
            }
            val loc = merged.getJSONObject("location")
            for (k in listOf("gpsIntervalMs", "fusedIntervalMs")) num(loc, k, "location.", -1.0, 600_000.0)
            val obd = merged.getJSONObject("obd")
            for (k in listOf("fastIntervalMs", "mediumIntervalMs", "slowIntervalMs", "otherIntervalMs", "demotedIntervalMs", "adapterVoltageIntervalMs")) {
                num(obd, k, "obd.", 0.0, 600_000.0)
            }
            num(obd, "requestTimeoutMs", "obd.", 100.0, 60_000.0)
            num(obd, "maxPidsPerRequest", "obd.", 0.0, 6.0)
            num(obd, "demoteAfterMisses", "obd.", 1.0, 1000.0)
            num(obd, "vehicleLostAfterSilent", "obd.", 1.0, 1000.0)
            for (k in listOf("fast", "medium", "slow")) {
                val a = obd.getJSONArray(k)
                for (i in 0 until a.length()) {
                    val v = a.opt(i)
                    if (v !is String || !HEX_PID.matches(v)) { out += "obd.$k has \"$v\"; PIDs are two hex digits like \"0C\""; break }
                }
            }
            if (obd.getString("engineOnly") !in setOf("auto", "on", "off")) out += "obd.engineOnly must be auto, on or off"
            val obdAddr = obd.getString("deviceAddress")
            if (obdAddr.isNotEmpty() && !BT_ADDRESS.matches(obdAddr)) out += "obd.deviceAddress isn't a Bluetooth address"
            val auto = merged.getJSONObject("auto")
            val carAddr = auto.getString("carAddress")
            if (carAddr.isNotEmpty() && !BT_ADDRESS.matches(carAddr)) out += "auto.carAddress isn't a Bluetooth address"
            num(auto, "stopAfterCarDisconnectS", "auto.", 0.0, 3600.0)
            num(auto, "stopAfterEngineOffS", "auto.", 0.0, 3600.0)
            num(auto, "adapterWaitS", "auto.", 0.0, 3600.0)
            return out
        }

        private fun fmt(x: Double) = if (x == Math.floor(x)) x.toLong().toString() else x.toString()

        private fun kind(v: Any?): String = when (v) {
            is JSONObject -> "an object"
            is JSONArray -> "a list"
            is String -> "text"
            is Boolean -> "true or false"
            is Number -> "a number"
            else -> "missing"
        }

        private fun sameKinds(defaults: JSONObject, merged: JSONObject, path: String, out: MutableList<String>) {
            for (k in defaults.keys()) {
                val d = defaults.get(k)
                val m = merged.opt(k)
                if (kind(d) != kind(m)) { out += "$path$k must be ${kind(d)}"; continue }
                if (d is JSONObject && path.isEmpty() && k != "sensors" && k != "sensorStoreHz") sameKinds(d, m as JSONObject, "$k.", out)
            }
        }

        fun upgrade(user: JSONObject): JSONObject {
            user.optJSONObject("sensors")?.let { if (sameJson(it, JSONObject(OLD_SENSORS_DEFAULT))) user.remove("sensors") }
            // upload.allowCellular (default off, only settable in the JSON) became upload.mobileData (default on,
            // a switch in Settings). Saved settings hold the old key as false, so it's dropped, not carried over.
            user.optJSONObject("upload")?.remove("allowCellular")
            user.optJSONObject("location")?.let { if (sameJson(it, JSONObject(OLD_LOCATION_DEFAULT))) user.remove("location") }
            // Old stop waits (2 min after Bluetooth, 5 min after engine off) recorded the walk away from the car.
            user.optJSONObject("auto")?.let { a ->
                if (a.optDouble("stopAfterCarDisconnectS") == 120.0) a.remove("stopAfterCarDisconnectS")
                if (a.optDouble("stopAfterEngineOffS") == 300.0) a.remove("stopAfterEngineOffS")
            }
            val obd = user.optJSONObject("obd") ?: return user
            for ((key, olds) in OLD_OBD_DEFAULTS) {
                val stored = obd.optJSONArray(key)?.let { a -> (0 until a.length()).map { a.getString(it).uppercase() } } ?: continue
                if (olds.any { it == stored }) obd.remove(key)
            }
            return user
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
