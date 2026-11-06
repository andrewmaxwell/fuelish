package app.fuelish.ui

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.PowerManager
import app.fuelish.Prefs
import app.fuelish.auto.CarBluetooth

/**
 * Where setup stands, in one place, so the setup list, the screen the app opens on, and the strip
 * along the bottom all agree. Each flag is one setup step; [gap] names the first one not done.
 */
data class Readiness(
    val serverSet: Boolean,
    val signedIn: Boolean,
    /** The server turned this phone's key away: signed in once, now needs to again. */
    val signInNeeded: Boolean,
    val permissions: Boolean,
    val missingPermissions: List<String>,
    val adapterChosen: Boolean,
    /** The chosen adapter passed the parked test (or there's no adapter on purpose). */
    val adapterDone: Boolean,
    val battery: Boolean,
    val vehicle: Boolean,
    /** Auto or manual recording was chosen. */
    val modeChosen: Boolean,
    val auto: Boolean,
    /** "Allow all the time" location, needed only for auto-record. */
    val background: Boolean,
) {
    val location get() = Manifest.permission.ACCESS_FINE_LOCATION !in missingPermissions

    /** The first unfinished step, in words for the bottom strip; null when everything's set. */
    val gap: String?
        get() = when {
            !serverSet -> "set the server"
            !signedIn -> if (signInNeeded) "sign in again to upload" else "sign in"
            !permissions -> "allow permissions"
            !adapterDone -> if (adapterChosen) "test the adapter" else "set up the adapter"
            !battery -> "allow running in the background"
            !vehicle -> "name the vehicle"
            !modeChosen -> "choose how recording starts"
            auto && !background -> "allow location all the time"
            else -> null
        }

    companion object {
        fun of(c: Context): Readiness {
            val cfg = Prefs.config(c)
            val missing = PERMISSIONS.filter { c.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
            val obdAddr = cfg.obd.optString("deviceAddress")
            val auto = cfg.auto.optBoolean("enabled") && cfg.auto.optString("carAddress").isNotBlank()
            val signInNeeded = Prefs.signInNeeded(c)
            val skipped = Prefs.skippedAdapter(c)
            return Readiness(
                serverSet = cfg.serverUrl.isNotBlank(),
                signedIn = cfg.serverUrl.isNotBlank() && cfg.deviceToken.isNotBlank() && !signInNeeded,
                signInNeeded = signInNeeded,
                permissions = missing.isEmpty(),
                missingPermissions = missing,
                adapterChosen = obdAddr.isNotBlank(),
                adapterDone = (obdAddr.isNotBlank() && (Prefs.adapterChecked(c).equals(obdAddr, ignoreCase = true) || Prefs.adapterTestSkipped(c).equals(obdAddr, ignoreCase = true))) ||
                    (obdAddr.isBlank() && skipped),
                battery = c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(c.packageName),
                // With an adapter the first drive (or the adapter test) names it from the VIN.
                vehicle = obdAddr.isNotBlank() || cfg.vehicle.isNotBlank(),
                modeChosen = Prefs.recordMode(c).isNotEmpty(),
                auto = auto,
                background = CarBluetooth.canStartInBackground(c),
            )
        }
    }
}
