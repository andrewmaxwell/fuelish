package app.fuelish.auto

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Debug builds only: lets adb stand in for the car's Bluetooth connect/disconnect broadcast. */
class DebugCarReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val address = intent.getStringExtra("address") ?: return
        CarBluetooth.onCarEvent(context, address, intent.getBooleanExtra("connected", true))
    }
}
