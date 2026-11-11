package app.fuelish.feedback

/**
 * When to say the end-of-drive summary. A recording that stops by itself does so a while after
 * parking (the auto-stop waits, in case it was a glitch), and by then the driver has often left the
 * car with the phone in a pocket. So the summary is said as soon as the drive looks over: the engine
 * answered earlier and has now been quiet for [QUIET_NS] with the phone standing still, and either
 * the adapter says the car stopped answering (ignition off) or the car's Bluetooth has gone.
 * A link that merely dropped doesn't count: that happens mid-drive, at a red light too.
 *
 * If the drive then goes on (a stop for gas), the summary is said again at the end only once
 * [AGAIN_MILES] more have been driven.
 */
class SummaryTiming {
    private var answered = false
    private var quietSinceNs = UNSET
    private var saidAtMiles = Double.NaN

    /** When the engine went quiet, if it is now: where the drive ended, for the summary's minutes. */
    val quietSince: Long? get() = quietSinceNs.takeIf { it != UNSET }

    /** Once a second. True when the summary should be said now. */
    fun tick(nowNs: Long, obdState: String, carConnected: Boolean, moving: Boolean, miles: Double): Boolean {
        if (obdState == "polling" || obdState == "benchmarking") {
            answered = true
            quietSinceNs = UNSET
            return false
        }
        if (!answered) return false
        if (quietSinceNs == UNSET) quietSinceNs = nowNs
        val over = obdState == "waiting_vehicle" || !carConnected
        if (!over || moving || nowNs - quietSinceNs < QUIET_NS || !due(miles)) return false
        saidAtMiles = miles
        return true
    }

    /** At the end of the recording: whether the summary is still to be said (and notes that it was). */
    fun atStop(miles: Double): Boolean = due(miles).also { if (it) saidAtMiles = miles }

    private fun due(miles: Double) = saidAtMiles.isNaN() || miles - saidAtMiles >= AGAIN_MILES

    companion object {
        private const val UNSET = Long.MIN_VALUE
        const val QUIET_NS = 3_000_000_000L
        const val AGAIN_MILES = 0.3
    }
}
