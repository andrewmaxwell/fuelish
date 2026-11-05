package app.fuelish.upload

import org.json.JSONArray

/**
 * A small route for the trip list, for chunks whose full `track` isn't uploaded (too big for the
 * header, or a chunk recovered after a crash). Points are [wallMs, lat, lon, speedMps, hAccM],
 * at most one every few seconds: enough for distance, moving time and the list's map outline.
 * The trip page still rebuilds the full route from the raw chunk.
 */
object RouteOutline {
    /** Spacings tried in turn. Kept under the 30 s gap the distance rule won't bridge. */
    private val STEPS_MS = longArrayOf(1_000, 2_000, 5_000, 10_000, 20_000)

    /** Thins [points] (track rows, oldest first) to fit in [maxChars] of JSON; null if nothing fits. */
    fun fit(points: JSONArray, maxChars: Int): JSONArray? {
        if (points.length() < 2 || maxChars <= 0) return null
        for (step in STEPS_MS) {
            val out = thin(points, step)
            if (out.length() >= 2 && out.toString().length <= maxChars) return out
        }
        return null
    }

    private fun thin(points: JSONArray, stepMs: Long): JSONArray {
        val out = JSONArray()
        var last = Long.MIN_VALUE
        val n = points.length()
        for (i in 0 until n) {
            val p = points.optJSONArray(i) ?: continue
            val t = p.optLong(0, Long.MIN_VALUE)
            if (t == Long.MIN_VALUE || p.isNull(1) || p.isNull(2)) continue
            if (last != Long.MIN_VALUE && t - last < stepMs && i != n - 1) continue
            last = t
            out.put(JSONArray().apply { for (k in 0 until minOf(5, p.length())) put(p.opt(k)) })
        }
        return out
    }
}
