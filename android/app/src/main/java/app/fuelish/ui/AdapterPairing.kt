package app.fuelish.ui

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.companion.AssociationInfo
import android.companion.AssociationRequest
import android.companion.BluetoothDeviceFilter
import android.companion.CompanionDeviceManager
import android.content.Context
import android.content.IntentSender
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.IntentCompat
import app.fuelish.Prefs
import org.json.JSONObject
import java.util.regex.Pattern

/**
 * Finds and pairs the OBD adapter without leaving the app: Android's companion-device sheet lists
 * nearby Bluetooth devices that look like OBD adapters, the person taps theirs, and it's paired and
 * chosen. Being the adapter's companion app also lets Fuelish run in the background (Android exempts
 * it from battery optimization), which is what recording needs.
 *
 * Returns the function that opens the sheet. [done] gets the adapter's name, or null with why not
 * ("" when they backed out).
 */
@Composable
fun rememberAdapterPairing(done: (name: String?, problem: String) -> Unit): () -> Unit {
    val ctx = LocalContext.current
    val onDone by rememberUpdatedState(done)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) { res ->
        if (res.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult onDone(null, "")
        val d = res.data?.let { deviceFrom(ctx, it) }
            ?: return@rememberLauncherForActivityResult onDone(null, "Android didn't say which adapter was picked. Try again.")
        onDone(choose(ctx, d), "")
    }
    return {
        val cdm = ctx.getSystemService(CompanionDeviceManager::class.java)
        if (cdm == null) {
            onDone(null, "This phone can't pair from inside apps. Pair the adapter in Android's Bluetooth settings, then choose it in Settings.")
        } else {
            // Names OBD adapters go by; anything else stays out of the list.
            val filter = BluetoothDeviceFilter.Builder()
                .setNamePattern(Pattern.compile("(?i).*(obd|elm ?327|vlink|v-link|veepeak|vgate|icar|kiwi|carista|bafx|lelink|konnwei|panlong|scan).*"))
                .build()
            val req = AssociationRequest.Builder().addDeviceFilter(filter).setSingleDevice(false).build()
            val cb = object : CompanionDeviceManager.Callback() {
                // On Android 13+ the system calls onAssociationPending, whose default calls this.
                @Deprecated("Deprecated in Java")
                override fun onDeviceFound(chooserLauncher: IntentSender) {
                    launcher.launch(IntentSenderRequest.Builder(chooserLauncher).build())
                }

                override fun onAssociationCreated(associationInfo: AssociationInfo) {}

                override fun onFailure(error: CharSequence?) {
                    val why = error?.toString().orEmpty()
                    onDone(
                        null,
                        if (why.contains("cancel", ignoreCase = true)) ""
                        else "No adapter found. Make sure it's plugged in with the car on, press its button, and try again.",
                    )
                }
            }
            try {
                if (Build.VERSION.SDK_INT >= 33) cdm.associate(req, ctx.mainExecutor, cb) else @Suppress("DEPRECATION") cdm.associate(req, cb, null)
            } catch (e: Exception) {
                onDone(null, "Couldn't look for adapters (${e.message ?: e.javaClass.simpleName}).")
            }
        }
    }
}

@SuppressLint("MissingPermission")
private fun deviceFrom(ctx: Context, data: android.content.Intent): BluetoothDevice? {
    IntentCompat.getParcelableExtra(data, CompanionDeviceManager.EXTRA_DEVICE, BluetoothDevice::class.java)?.let { return it }
    if (Build.VERSION.SDK_INT >= 33) {
        val info = IntentCompat.getParcelableExtra(data, CompanionDeviceManager.EXTRA_ASSOCIATION, AssociationInfo::class.java)
        if (Build.VERSION.SDK_INT >= 34) info?.associatedDevice?.bluetoothDevice?.let { return it }
        val mac = info?.deviceMacAddress?.toString()?.uppercase() ?: return null
        return ctx.getSystemService(BluetoothManager::class.java)?.adapter?.getRemoteDevice(mac)
    }
    return null
}

/** Pairs [d] if it isn't yet and makes it the adapter recordings use. Returns its name. */
@SuppressLint("MissingPermission")
private fun choose(ctx: Context, d: BluetoothDevice): String {
    val canConnect = ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
    val name = (if (canConnect) d.name else null) ?: "OBD adapter"
    if (canConnect && d.bondState == BluetoothDevice.BOND_NONE) d.createBond()
    val cfg = JSONObject(Prefs.config(ctx).json.toString())
    cfg.getJSONObject("obd").put("deviceAddress", d.address.uppercase()).put("deviceName", name)
    runCatching { Prefs.saveConfig(ctx, cfg.toString()) }
    Prefs.setSkippedAdapter(ctx, false)
    return name
}
