package app.fuelish.auto

/**
 * Decides when an automatically started recording should end. Evaluated once a second.
 *
 * - Car Bluetooth disconnected for [stopAfterDisconnectNs] (short: nothing after parking is worth
 *   recording) while the engine isn't answering OBD. If the engine is still answering, the car is
 *   running and it was a Bluetooth glitch, so the trip goes on; reconnecting cancels it too. Without
 *   an adapter a drop longer than the wait splits the trip, and the web app joins the pieces into one
 *   outing.
 * - The OBD adapter is reachable but the car stopped answering (ignition off) for
 *   [stopAfterEngineOffNs], e.g. parked with Bluetooth still on. An adapter link failure alone
 *   never stops a recording, so a flaky MX+ can't cut a drive short.
 * - Android said the person left the vehicle (they're walking: see [DriveDetect]), and the engine
 *   isn't answering, for [stopAfterDisconnectNs]. It covers a drive whose adapter dropped and never
 *   came back, which the engine-off rule can't see. The engine answering again cancels it.
 * - [adapterWaitNs] after the first check the engine still hasn't answered once: the recording was
 *   started by detecting a drive, and this isn't a car with the adapter in it (a friend's car, a bus).
 *   Unless there's other evidence it's your car ([ownCarEvidence]): the adapter's Bluetooth link came
 *   up (it's plugged into your car, and in range), or the phone is on a car stereo it's paired with.
 *   Then the adapter is just being slow or the car isn't answering it, and the drive goes on, recorded
 *   from the phone ([keptWithoutEngine]). Such a drive has no engine to go quiet, so the engine-off
 *   rule waits for the engine to have answered; leaving the vehicle ends it.
 *
 * A zero threshold disables that rule.
 */
class AutoStopPolicy(
    private val stopAfterDisconnectNs: Long,
    private val stopAfterEngineOffNs: Long,
    private val adapterWaitNs: Long = 0,
) {
    private var carConnected = true
    private var disconnectedAtNs = 0L
    private var engineOffSinceNs = 0L
    private var leftVehicleAtNs = 0L
    private var firstCheckNs = Long.MIN_VALUE
    /** The engine has answered at least once in this recording. */
    var engineAnswered = false
        private set
    private var adapterReached = false
    private var pairedCar = false
    /** Signs this is the driver's own car even though the engine hasn't answered. */
    val ownCarEvidence get() = adapterReached || pairedCar
    /** The adapter wait ran out without the engine answering, and the drive was kept on [ownCarEvidence]. */
    var keptWithoutEngine = false
        private set

    /** The phone is connected to a car stereo it's paired with. */
    fun onPairedCar() {
        pairedCar = true
    }

    fun carEvent(connected: Boolean, nowNs: Long) {
        if (connected) carConnected = true
        else if (carConnected) {
            carConnected = false
            disconnectedAtNs = nowNs
        }
    }

    /** Android detected the person leaving the vehicle (walking) at [nowNs]. */
    fun leftVehicle(nowNs: Long) {
        if (leftVehicleAtNs == 0L) leftVehicleAtNs = nowNs
    }

    /**
     * When the drive ended for [reason] (a value [check] returned), on the elapsed-time clock: the
     * Bluetooth disconnect, the moment the engine stopped answering, or leaving the vehicle; not when
     * the wait ran out.
     */
    fun driveEndNs(reason: String): Long? = when (reason) {
        "car_disconnected" -> disconnectedAtNs.takeIf { it != 0L }
        "engine_off" -> engineOffSinceNs.takeIf { it != 0L }
        "left_vehicle" -> leftVehicleAtNs.takeIf { it != 0L }
        else -> null
    }

    /** Returns a stop reason, or null to keep recording. */
    fun check(nowNs: Long, obdState: String): String? {
        if (firstCheckNs == Long.MIN_VALUE) firstCheckNs = nowNs
        val engineAnswering = obdState == "polling" || obdState == "benchmarking"
        if (engineAnswering) {
            engineAnswered = true
            leftVehicleAtNs = 0 // back in a running car: the walk was a false alarm, or an old one
        }
        when (obdState) {
            "polling", "benchmarking" -> engineOffSinceNs = 0
            "waiting_vehicle" -> if (engineOffSinceNs == 0L) engineOffSinceNs = nowNs
            // connecting/disconnected/...: leave the timer as is. The MX+ goes to sleep after
            // the car is switched off, so the engine-off clock keeps running through that.
        }
        if (obdState in LINK_UP) adapterReached = true
        if (adapterWaitNs > 0 && !engineAnswered && nowNs - firstCheckNs >= adapterWaitNs) {
            if (!ownCarEvidence) return "no_adapter"
            keptWithoutEngine = true
        }
        if (!carConnected && !engineAnswering && stopAfterDisconnectNs > 0 && nowNs - disconnectedAtNs >= stopAfterDisconnectNs) {
            return "car_disconnected"
        }
        if (leftVehicleAtNs != 0L && !engineAnswering && stopAfterDisconnectNs > 0 && nowNs - leftVehicleAtNs >= stopAfterDisconnectNs) {
            return "left_vehicle"
        }
        // A detected drive whose engine never answered has no engine-off to see (see the class comment).
        val engineSeen = adapterWaitNs == 0L || engineAnswered
        if (engineSeen && engineOffSinceNs != 0L && stopAfterEngineOffNs > 0 && nowNs - engineOffSinceNs >= stopAfterEngineOffNs) {
            return "engine_off"
        }
        return null
    }

    private companion object {
        /** Adapter states that mean its Bluetooth link is up. */
        val LINK_UP = setOf("initializing", "discovering", "waiting_vehicle", "benchmarking", "polling")
    }
}
