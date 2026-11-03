package app.fuelish.auto

import android.Manifest
import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.IntentCompat
import app.fuelish.Prefs
import app.fuelish.R
import app.fuelish.RecorderService
import app.fuelish.ui.MainActivity

/**
 * Receives Bluetooth ACL connect/disconnect broadcasts (exempt from implicit-broadcast limits,
 * and a Bluetooth broadcast lets the app start a foreground service from the background) and
 * starts/notifies the recorder when the selected car head unit comes and goes.
 */
class CarBluetoothReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val connected = when (intent.action) {
            BluetoothDevice.ACTION_ACL_CONNECTED -> true
            BluetoothDevice.ACTION_ACL_DISCONNECTED -> false
            else -> return
        }
        val device = IntentCompat.getParcelableExtra(intent, BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java) ?: return
        CarBluetooth.onCarEvent(context, device.address, connected)
    }
}

object CarBluetooth {
    private const val TAG = "FuelishAuto"
    private const val CHANNEL = "auto"
    private const val NOTIFICATION_ID = 2
    const val TRIGGER_CAR = "car_bluetooth"
    const val TRIGGER_CAR_NOTIFICATION = "car_bluetooth_notification"

    fun createChannel(c: Context) {
        c.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Car connected", NotificationManager.IMPORTANCE_HIGH),
        )
    }

    /** Location in a service started from the background needs "Allow all the time". */
    fun canStartInBackground(c: Context) =
        listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            .all { c.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    fun onCarEvent(c: Context, address: String, connected: Boolean) {
        val auto = Prefs.config(c).auto
        if (!auto.optBoolean("enabled") || !address.equals(auto.optString("carAddress"), ignoreCase = true)) return
        Log.i(TAG, "car ${if (connected) "connected" else "disconnected"}")

        if (RecorderService.activeId != null) {
            // Already recording (auto or manual): just tell the session. The app has a
            // foreground service, so a plain startService is allowed.
            c.startService(Intent(c, RecorderService::class.java).setAction(
                if (connected) RecorderService.ACTION_CAR_CONNECTED else RecorderService.ACTION_CAR_DISCONNECTED,
            ))
            return
        }
        if (!connected) {
            c.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
            return
        }
        if (!canStartInBackground(c)) {
            notifyTapToRecord(c, "Location isn't set to \"Allow all the time\", so recording can't start by itself.")
            return
        }
        try {
            RecorderService.start(c, "", TRIGGER_CAR)
        } catch (e: ForegroundServiceStartNotAllowedException) {
            Log.w(TAG, "background start refused", e)
            notifyTapToRecord(c, "Android didn't allow a background start.")
        } catch (e: SecurityException) {
            Log.w(TAG, "background start refused", e)
            notifyTapToRecord(c, "Android didn't allow a background start.")
        }
    }

    /** Fallback when Android refuses a background start: one tap opens the app and records. */
    private fun notifyTapToRecord(c: Context, why: String) {
        val open = PendingIntent.getActivity(
            c, 3,
            Intent(c, MainActivity::class.java).putExtra(MainActivity.EXTRA_START_TRIGGER, TRIGGER_CAR_NOTIFICATION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val n = Notification.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Car connected: tap to record")
            .setContentText(why)
            .setStyle(Notification.BigTextStyle().bigText(why))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        c.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)
    }
}
