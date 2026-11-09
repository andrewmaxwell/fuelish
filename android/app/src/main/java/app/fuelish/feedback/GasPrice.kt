package app.fuelish.feedback

import android.content.Context
import app.fuelish.Prefs
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * The latest weekly average price of regular gas for where a drive started (U.S. EIA, through the
 * server's /api/v1/gas-prices), as the trip page uses. Fetched at the start of a drive and kept for
 * half a day, so the end-of-drive summary can say what the gas cost without waiting on the network.
 */
object GasPrice {
    private const val KEEP_MS = 12 * 3600_000L

    /** Refreshes the kept prices if they're old. Blocking: call off the main thread. */
    fun refresh(c: Context) {
        val kept = Prefs.gasPrices(c)?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (kept != null && System.currentTimeMillis() - kept.optLong("fetchedMs") < KEEP_MS) return
        val server = Prefs.config(c).serverUrl
        if (server.isBlank()) return
        runCatching {
            val conn = URL("$server/api/v1/gas-prices").openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000
            try {
                if (conn.responseCode != 200) return
                val latest = latestByRegion(JSONObject(conn.inputStream.bufferedReader().readText()))
                if (latest.length() > 0) Prefs.setGasPrices(c, JSONObject().put("fetchedMs", System.currentTimeMillis()).put("prices", latest).toString())
            } finally {
                conn.disconnect()
            }
        }
    }

    /** $/gal for a drive that started at [lat], [lon] (NaN when unknown), from the kept prices. */
    fun forPlace(c: Context, lat: Double, lon: Double): Double? {
        val prices = Prefs.gasPrices(c)?.let { runCatching { JSONObject(it).getJSONObject("prices") }.getOrNull() } ?: return null
        val p = prices.optDouble(region(lat, lon))
        return if (p.isNaN()) prices.optDouble("us").takeIf { !it.isNaN() } else p
    }

    /** { region: latest $/gal } from the server's answer ({ regions: { key: { weeks: [[ms, price], ...] } } }). */
    fun latestByRegion(body: JSONObject): JSONObject {
        val out = JSONObject()
        val regions = body.optJSONObject("regions") ?: return out
        for (k in regions.keys()) {
            val weeks = regions.optJSONObject(k)?.optJSONArray("weeks") ?: continue
            if (weeks.length() == 0) continue
            val last = weeks.optJSONArray(weeks.length() - 1) ?: continue
            out.put(k, last.optDouble(1))
        }
        return out
    }

    /** EIA's five regions, roughly by where a drive starts; outside the lower 48, the U.S. average. Same as the web app's. */
    fun region(lat: Double, lon: Double): String = when {
        lat.isNaN() || lon.isNaN() || lat < 24 || lat > 50 || lon < -125 || lon > -66 -> "us"
        lon < -114 || (lon < -109 && lat < 37) -> "west"
        lon < -102 && lat >= 37 -> "rockies"
        lat < 33.5 && lon < -85 && lon > -107 -> "gulf"
        lat < 36.5 && lon < -89.5 && lon > -94.5 -> "gulf"
        lon > -80.5 || (lon > -85 && lat < 34.5) -> "east"
        else -> "midwest"
    }
}
