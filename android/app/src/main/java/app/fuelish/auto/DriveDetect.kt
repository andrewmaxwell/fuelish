package app.fuelish.auto

import android.Manifest
import android.annotation.SuppressLint
import android.app.ForegroundServiceStartNotAllowedException
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Log
import app.fuelish.Config
import app.fuelish.Prefs
import app.fuelish.RecorderService
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity

/**
 * Auto-record without choosing the car's Bluetooth: Android's activity recognition says when the
 * phone starts riding in a vehicle, and the recorder then tries the OBD adapter. If the engine never
 * answers through it (someone else's car, a bus), the recording is thrown away unseen (see
 * [AutoStopPolicy] "no_adapter"); its uploads wait until the engine answers. Leaving the vehicle
 * (walking) is a stop signal too.
 *
 * Android notices a drive a minute or two into it, so the start is missed. Choosing the car's
 * Bluetooth as well starts recording as soon as the phone connects, as before.
 *
 * Android allows a foreground service to start from the background on an activity-transition event.
 * The registration doesn't survive a reboot or an update, so it's renewed then and at app start.
 */
object DriveDetect {
    private const val TAG = "FuelishAuto"
    const val TRIGGER = "driving_detected"
    private const val ACTION = "app.fuelish.ACTIVITY_TRANSITION"
    /** An event older than this is history, not a drive starting now. */
    private const val MAX_EVENT_AGE_NS = 3 * 60 * 1_000_000_000L

    private fun hasAdapter(cfg: Config) = cfg.obd.optString("deviceAddress").isNotBlank()

    /** A detected drive starts recording: auto-record is on and there's an adapter to prove the car. */
    fun detects(cfg: Config) = cfg.auto.optBoolean("enabled") && hasAdapter(cfg)

    /** Auto-record is set up: by detecting drives (with an adapter) or by the car's Bluetooth. */
    fun autoOn(cfg: Config) = detects(cfg) || (cfg.auto.optBoolean("enabled") && cfg.auto.optString("carAddress").isNotBlank())

    fun permitted(c: Context) =
        c.checkSelfPermission(Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED

    private fun pendingIntent(c: Context) = PendingIntent.getBroadcast(
        c, 7, Intent(c, DriveDetectReceiver::class.java).setAction(ACTION),
        // Mutable: Play services adds the transition result to it.
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )

    /** Registers for vehicle enter/exit when auto-record wants it, and unregisters otherwise. Cheap; idempotent. */
    @SuppressLint("MissingPermission")
    fun sync(c: Context) {
        val client = ActivityRecognition.getClient(c)
        if (!detects(Prefs.config(c)) || !permitted(c)) {
            runCatching { client.removeActivityTransitionUpdates(pendingIntent(c)) }
            return
        }
        val transitions = listOf(ActivityTransition.ACTIVITY_TRANSITION_ENTER, ActivityTransition.ACTIVITY_TRANSITION_EXIT).map {
            ActivityTransition.Builder().setActivityType(DetectedActivity.IN_VEHICLE).setActivityTransition(it).build()
        }
        runCatching {
            client.requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), pendingIntent(c))
                .addOnFailureListener { Log.w(TAG, "couldn't register for drive detection", it) }
        }.onFailure { Log.w(TAG, "couldn't register for drive detection", it) }
    }

    fun onTransition(c: Context, intent: Intent) {
        val result = ActivityTransitionResult.extractResult(intent) ?: return
        val now = SystemClock.elapsedRealtimeNanos()
        val last = result.transitionEvents.filter { it.activityType == DetectedActivity.IN_VEHICLE }.maxByOrNull { it.elapsedRealTimeNanos } ?: return
        if (now - last.elapsedRealTimeNanos > MAX_EVENT_AGE_NS) return
        if (last.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER) onDriving(c) else onLeftVehicle(c)
    }

    fun onDriving(c: Context) {
        if (!detects(Prefs.config(c)) || RecorderService.activeId != null) return
        if (!CarBluetooth.canStartInBackground(c)) {
            Log.i(TAG, "drive detected, but location isn't allowed all the time")
            return
        }
        Log.i(TAG, "drive detected: recording")
        try {
            RecorderService.start(c, "", TRIGGER)
        } catch (e: ForegroundServiceStartNotAllowedException) {
            Log.w(TAG, "background start refused", e)
        } catch (e: SecurityException) {
            Log.w(TAG, "background start refused", e)
        }
    }

    fun onLeftVehicle(c: Context) {
        if (RecorderService.activeId == null) return
        Log.i(TAG, "left the vehicle")
        // The app has a foreground service running, so a plain startService is allowed.
        c.startService(Intent(c, RecorderService::class.java).setAction(RecorderService.ACTION_LEFT_VEHICLE))
    }
}

/** Activity-transition results from Play services. */
class DriveDetectReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = DriveDetect.onTransition(context, intent)
}

/** Drive detection is forgotten on reboot: register again. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) DriveDetect.sync(context)
    }
}
