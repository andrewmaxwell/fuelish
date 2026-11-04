package app.fuelish.auto

/**
 * Decides when an automatically started recording should end. Evaluated once a second.
 *
 * - Car Bluetooth disconnected for [stopAfterDisconnectNs] (reconnecting within that window
 *   cancels it, so brief Bluetooth drops don't split a trip).
 * - The OBD adapter is reachable but the car stopped answering (ignition off) for
 *   [stopAfterEngineOffNs]. An adapter link failure alone never stops a recording, so a
 *   flaky MX+ can't cut a drive short; phone sensors keep recording regardless.
 *
 * A zero threshold disables that rule.
 */
class AutoStopPolicy(private val stopAfterDisconnectNs: Long, private val stopAfterEngineOffNs: Long) {
    private var carConnected = true
    private var disconnectedAtNs = 0L
    private var engineOffSinceNs = 0L

    fun carEvent(connected: Boolean, nowNs: Long) {
        if (connected) carConnected = true
        else if (carConnected) {
            carConnected = false
            disconnectedAtNs = nowNs
        }
    }

    /**
     * When the drive ended for [reason] (a value [check] returned), on the elapsed-time clock: the
     * Bluetooth disconnect or the moment the engine stopped answering, not when the wait ran out.
     */
    fun driveEndNs(reason: String): Long? = when (reason) {
        "car_disconnected" -> disconnectedAtNs.takeIf { it != 0L }
        "engine_off" -> engineOffSinceNs.takeIf { it != 0L }
        else -> null
    }

    /** Returns a stop reason, or null to keep recording. */
    fun check(nowNs: Long, obdState: String): String? {
        when (obdState) {
            "polling", "benchmarking" -> engineOffSinceNs = 0
            "waiting_vehicle" -> if (engineOffSinceNs == 0L) engineOffSinceNs = nowNs
            // connecting/disconnected/...: leave the timer as is. The MX+ goes to sleep after
            // the car is switched off, so the engine-off clock keeps running through that.
        }
        if (!carConnected && stopAfterDisconnectNs > 0 && nowNs - disconnectedAtNs >= stopAfterDisconnectNs) {
            return "car_disconnected"
        }
        if (engineOffSinceNs != 0L && stopAfterEngineOffNs > 0 && nowNs - engineOffSinceNs >= stopAfterEngineOffNs) {
            return "engine_off"
        }
        return null
    }
}
