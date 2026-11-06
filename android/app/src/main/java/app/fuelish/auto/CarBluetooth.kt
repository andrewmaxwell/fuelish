package app.fuelish.auto

import android.Manifest
import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.annotation.SuppressLint
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
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
        // Every device, not just the chosen car: a drive later suggests the car it was connected to.
        Prefs.setBtConnected(context, device.address, connected)
        CarBluetooth.onCarEvent(context, device.address, connected)
    }
}

/**
 * After an update replaces the app (which kills a recording in progress), carries on recording
 * if the update cut a drive short: a manual recording always, an automatic one while the car's
 * Bluetooth is still connected. The new recording names the one it continues (`resumes`), so the
 * web app shows the two as one drive. MY_PACKAGE_REPLACED may start a foreground service from the
 * background.
 */
class AppUpdatedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED || RecorderService.activeId != null) return
        val (id, meta) = Prefs.store(context).claimCutShort(System.currentTimeMillis(), 3 * 60_000) ?: return
        val trigger = meta.optString("trigger", RecorderService.TRIGGER_MANUAL)
        val auto = trigger != RecorderService.TRIGGER_MANUAL
        if (auto && !(Prefs.config(context).auto.optBoolean("enabled") && Prefs.carConnected(context))) return
        if (!CarBluetooth.canStartInBackground(context)) return
        Log.i("FuelishAuto", "app updated mid-recording: resuming $id")
        runCatching { RecorderService.start(context, meta.optString("note"), trigger, resumes = id) }
            .onFailure { Log.w("FuelishAuto", "couldn't resume after the update", it) }
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

    /**
     * A car stereo or hands-free kit, by the Bluetooth class it reports (most cars say "car audio" or
     * "hands-free"). Only used to list likely cars first; anything can still be picked.
     */
    @SuppressLint("MissingPermission")
    fun looksLikeCar(d: BluetoothDevice): Boolean {
        val c = d.bluetoothClass?.deviceClass ?: return false
        return c == BluetoothClass.Device.AUDIO_VIDEO_CAR_AUDIO || c == BluetoothClass.Device.AUDIO_VIDEO_HANDSFREE
    }

    /** A car that doesn't say "car audio": some other audio device that isn't headphones or a speaker. */
    @SuppressLint("MissingPermission")
    private fun maybeCar(d: BluetoothDevice): Boolean {
        val cls = d.bluetoothClass ?: return false
        if (cls.majorDeviceClass != BluetoothClass.Device.Major.AUDIO_VIDEO) return false
        return cls.deviceClass !in setOf(
            BluetoothClass.Device.AUDIO_VIDEO_HEADPHONES, BluetoothClass.Device.AUDIO_VIDEO_WEARABLE_HEADSET,
            BluetoothClass.Device.AUDIO_VIDEO_PORTABLE_AUDIO, BluetoothClass.Device.AUDIO_VIDEO_LOUDSPEAKER,
            BluetoothClass.Device.AUDIO_VIDEO_HIFI_AUDIO,
        )
    }

    /**
     * During a drive: if auto-record isn't set up, remembers the car's Bluetooth the phone is connected
     * to, so the app can offer "record automatically when connected to it?". A car stereo wins over
     * other audio; headphones, the OBD adapter and anything already turned down never count.
     */
    @SuppressLint("MissingPermission")
    fun noticeCar(c: Context) {
        val cfg = Prefs.config(c)
        if (cfg.auto.optBoolean("enabled") && cfg.auto.optString("carAddress").isNotBlank()) return
        if (Prefs.autoSuggestion(c) != null) return
        if (c.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) return
        val adapter = c.getSystemService(BluetoothManager::class.java)?.adapter ?: return
        val obd = cfg.obd.optString("deviceAddress")
        val declined = Prefs.autoDeclined(c)
        val connected = Prefs.btConnected(c)
            .filter { !it.equals(obd, ignoreCase = true) && it.uppercase() !in declined }
            .mapNotNull { runCatching { adapter.getRemoteDevice(it.uppercase()) }.getOrNull() }
        val car = connected.firstOrNull(::looksLikeCar) ?: connected.singleOrNull(::maybeCar) ?: return
        Prefs.setAutoSuggestion(c, car.name ?: "your car", car.address)
    }

    /** Location in a service started from the background needs "Allow all the time". */
    fun canStartInBackground(c: Context) =
        listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            .all { c.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    fun onCarEvent(c: Context, address: String, connected: Boolean) {
        val auto = Prefs.config(c).auto
        if (!auto.optBoolean("enabled") || !address.equals(auto.optString("carAddress"), ignoreCase = true)) return
        Log.i(TAG, "car ${if (connected) "connected" else "disconnected"}")
        Prefs.setCarConnected(c, connected)

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
                .putExtra(MainActivity.EXTRA_START_PASS, Prefs.newStartPass(c))
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
