package app.fuelish.upload

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * The car's name from its VIN, asked of the server (which asks NHTSA's decoder). Blocking: call off
 * the main thread. Null when the server can't name it or can't be reached; the next drive tries again.
 */
object VehicleLookup {
    fun name(serverUrl: String, token: String, vin: String): String? {
        if (serverUrl.isBlank() || token.isBlank()) return null
        return try {
            val c = URL("${serverUrl.trimEnd('/')}/api/v1/vehicles/vin/$vin").openConnection() as HttpURLConnection
            c.connectTimeout = 15_000
            c.readTimeout = 15_000
            c.setRequestProperty("Authorization", "Bearer $token")
            try {
                if (c.responseCode != 200) null
                else JSONObject(c.inputStream.bufferedReader().readText()).optString("name").takeIf { it.isNotBlank() }
            } finally {
                c.disconnect()
            }
        } catch (_: Exception) {
            null
        }
    }
}
