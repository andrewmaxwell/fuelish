package app.fuelish.feedback

import java.util.Locale
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * A running total of the drive for the spoken summary: miles from GPS and gallons from the engine.
 * Rougher than the trip page (which also corrects for fuel trims and fills gaps), but close, and
 * ready the moment the drive ends.
 *
 * Fuel per second is the car's own fuel rate if it reports one, else airflow over the commanded
 * air-fuel ratio, as in the web app's engine summary.
 */
class DriveTally {
    var meters = 0.0
        private set
    private var fuelGrams = 0.0
    private var fuelSeconds = 0.0
    private var lastLat = Double.NaN
    private var lastLon = Double.NaN
    /** Where the drive started (the first good fix), for the regional gas price. */
    var startLat = Double.NaN
        private set
    var startLon = Double.NaN
        private set

    /** A GPS fix. Only fixes accurate to [MAX_ACCURACY_M] count, and only while moving, so parked jitter adds nothing. */
    fun gps(lat: Double, lon: Double, accuracyM: Double, speedMps: Double) {
        if (accuracyM > MAX_ACCURACY_M) return
        if (startLat.isNaN()) {
            startLat = lat
            startLon = lon
        }
        if (speedMps >= 1.0 && !lastLat.isNaN()) meters += distanceM(lastLat, lastLon, lat, lon)
        lastLat = lat
        lastLon = lon
    }

    /** [dtS] seconds of engine running at the latest [values]; call only while the engine answers. */
    fun engine(dtS: Double, values: Map<String, Double>) {
        val gs = fuelGs(values) ?: return
        fuelGrams += gs * dtS
        fuelSeconds += dtS
    }

    val miles get() = meters / M_PER_MILE

    /** Gallons burned, or null when the engine gave fuel readings for too little of the drive. */
    val gallons: Double? get() = if (fuelSeconds < 30) null else fuelGrams / FUEL_G_PER_L / L_PER_GAL

    companion object {
        private const val MAX_ACCURACY_M = 30.0
        private const val M_PER_MILE = 1609.344
        private const val FUEL_G_PER_L = 745.0
        private const val L_PER_GAL = 3.78541
        private const val AFR = 14.08

        fun fuelGs(v: Map<String, Double>): Double? {
            v["fuel_rate"]?.let { return it * FUEL_G_PER_L / 3600 }
            val maf = v["maf"] ?: return null
            val lambda = v["commanded_lambda"] ?: 1.0
            if (lambda >= 1.99) return 0.0 // fuel cut
            return maf / (AFR * lambda.coerceAtLeast(0.5))
        }

        fun distanceM(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
            val r = 6_371_000.0
            val dLat = Math.toRadians(lat2 - lat1)
            val dLon = Math.toRadians(lon2 - lon1)
            val a = sin(dLat / 2).let { it * it } + cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2).let { it * it }
            return 2 * r * asin(sqrt(a))
        }

        /**
         * The spoken end-of-drive summary, or null for a drive too short to bother with. [price]: $/gal,
         * when known.
         */
        fun summary(miles: Double, minutes: Double, gallons: Double?, price: Double?): String? {
            if (miles < 0.3) return null
            val parts = mutableListOf("Drive saved. ${fmt1(miles)} miles in ${duration(minutes)}.")
            if (gallons != null && gallons > 0) {
                val mpg = (miles / gallons).roundToInt()
                var s = "${fmtGal(gallons)} gallons, $mpg miles per gallon"
                if (price != null) s += ", about ${money(gallons * price)} of gas"
                parts += "$s."
            }
            return parts.joinToString(" ")
        }

        private fun fmt1(x: Double) = String.format(Locale.US, "%.1f", x)
        private fun fmtGal(g: Double) = String.format(Locale.US, if (g < 1) "%.2f" else "%.1f", g)

        private fun duration(minutes: Double): String {
            val m = minutes.roundToInt().coerceAtLeast(1)
            val h = m / 60
            val rest = m % 60
            val mins = if (rest == 1) "1 minute" else "$rest minutes"
            return when {
                h == 0 -> mins
                rest == 0 -> if (h == 1) "1 hour" else "$h hours"
                else -> "${if (h == 1) "1 hour" else "$h hours"} $mins"
            }
        }

        private fun money(d: Double): String {
            val cents = (d * 100).roundToInt()
            return if (cents < 100) "$cents cents" else String.format(Locale.US, "$%d.%02d", cents / 100, cents % 100)
        }
    }
}
