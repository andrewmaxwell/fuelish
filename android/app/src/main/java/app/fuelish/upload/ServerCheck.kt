package app.fuelish.upload

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** One-shot connectivity/token check for the settings screen. Blocking: call off the main thread. */
object ServerCheck {
    data class Result(val ok: Boolean, val message: String)

    fun check(baseUrl: String, token: String): Result {
        if (baseUrl.isBlank()) return Result(false, "Enter the server URL.")
        if (token.isBlank()) return Result(false, "Enter the device token.")
        return try {
            val c = URL(baseUrl.trimEnd('/') + "/api/v1/me").openConnection() as HttpURLConnection
            c.connectTimeout = 10_000
            c.readTimeout = 10_000
            c.setRequestProperty("Authorization", "Bearer $token")
            try {
                when (val code = c.responseCode) {
                    200 -> {
                        val scopes = JSONObject(c.inputStream.bufferedReader().readText()).optJSONArray("scopes")?.toString().orEmpty()
                        if ("upload" in scopes) Result(true, "Connected. This phone can upload.")
                        else Result(false, "Connected, but this token can't upload. Is it the web token instead of the device token?")
                    }
                    401 -> Result(false, "The server rejected this token.")
                    404 -> Result(false, "No Fuelish server at that URL.")
                    else -> Result(false, "Server answered HTTP $code.")
                }
            } finally {
                c.disconnect()
            }
        } catch (e: Exception) {
            Result(false, "Couldn't reach the server (${e.message ?: e.javaClass.simpleName}).")
        }
    }
}
