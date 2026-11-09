package app.fuelish.auto

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Debug builds only: lets adb stand in for the car's Bluetooth connect/disconnect broadcast, or for
 * Android detecting a drive (`--ez driving true|false`).
 */
class DebugCarReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.hasExtra("driving")) {
            if (intent.getBooleanExtra("driving", true)) DriveDetect.onDriving(context) else DriveDetect.onLeftVehicle(context)
            return
        }
        val address = intent.getStringExtra("address") ?: return
        CarBluetooth.onCarEvent(context, address, intent.getBooleanExtra("connected", true))
    }
}
