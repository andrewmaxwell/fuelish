package app.fuelish

import android.content.Context
import app.fuelish.upload.VehicleLookup
import org.json.JSONObject

/**
 * Names the vehicle from the VIN the adapter reads, unless someone typed a name. A phone that moves
 * to another car gets that car's name, so each trip is labeled with the car it was in.
 *
 * A trip starts with the phone's current vehicle name. When the adapter reads a different car's VIN,
 * the trip's name is cleared and the trip remembers that VIN (meta `vehicleVin`): no name is better
 * than the wrong car's. The lookup needs the internet. When it fails (a phone that only has Wi-Fi, a
 * drive with no signal), the VIN waits and the upload worker asks again once it's online, before it
 * uploads, so those trips go up named.
 *
 * Only the VIN read most recently changes the phone's vehicle: a late answer for a car you've since
 * left doesn't switch the phone back to it.
 */
object VehicleNaming {
    private fun typed(cfg: Config) = cfg.vehicle.isNotBlank() && cfg.vehicleVin.isBlank()

    /** Whether [vin] would rename the vehicle (it's new, and nobody typed a name). */
    fun wanted(c: Context, vin: String): Boolean {
        val now = Prefs.config(c)
        return !now.vehicleVin.equals(vin, ignoreCase = true) && !typed(now)
    }

    /**
     * The name for [vin]: the phone's vehicle if it's that car, else asked of the server. Blocking.
     * Saves it as the phone's vehicle when [vin] is the car the adapter read last and nobody typed a
     * name. Null when it couldn't be looked up; then the VIN is kept for [retry].
     */
    fun lookUp(c: Context, vin: String): String? {
        val cfg = Prefs.config(c)
        if (cfg.vehicleVin.equals(vin, ignoreCase = true) && cfg.vehicle.isNotBlank()) return cfg.vehicle
        val named = VehicleLookup.name(cfg.serverUrl, cfg.deviceToken, vin)
        if (named == null) {
            Prefs.setPendingVin(c, vin)
            return null
        }
        if (Prefs.pendingVin(c).equals(vin, ignoreCase = true)) Prefs.setPendingVin(c, "")
        val latest = Prefs.config(c)
        if (Prefs.lastVin(c).equals(vin, ignoreCase = true) && !typed(latest)) {
            runCatching { Prefs.saveConfig(c, JSONObject(latest.json.toString()).put("vehicle", named).put("vehicleVin", vin).toString()) }
        }
        return named
    }

    /** Whether a finished recording is waiting for [vin]'s name. */
    fun awaits(meta: JSONObject, vin: String): Boolean {
        if (meta.optString("vehicle").isNotBlank() || meta.optString("status") == "recording") return false
        // Older recordings didn't keep `vehicleVin`; their VIN is in the OBD summary.
        val tripVin = meta.optString("vehicleVin").ifBlank {
            meta.optJSONObject("summary")?.optJSONObject("obd")?.optJSONObject("discovery")
                ?.optJSONObject("vehicleInfo")?.optString("vin").orEmpty()
        }
        return tripVin.equals(vin, ignoreCase = true)
    }

    /**
     * Tries a waiting VIN again, and names the finished recordings on this phone that were made with
     * it while the name was unknown. Blocking; the upload worker calls it before uploading.
     */
    fun retry(c: Context) {
        val vin = Prefs.pendingVin(c)
        if (vin.isBlank()) return
        val named = lookUp(c, vin) ?: return
        val store = Prefs.store(c)
        for (id in store.ids()) {
            if (id == RecorderService.activeId) continue
            val meta = runCatching { store.readMeta(id) }.getOrNull() ?: continue
            if (!awaits(meta, vin)) continue
            meta.put("vehicle", named)
            store.writeMeta(id, meta)
        }
    }
}
