package app.fuelish

import android.content.Context
import app.fuelish.upload.VehicleLookup
import org.json.JSONObject

/**
 * Names the vehicle from the VIN the adapter reads, unless someone typed a name. A phone that moves
 * to another car gets that car's name, so each trip is labeled with the car it was in.
 *
 * The lookup needs the internet. When it fails (a phone that only has Wi-Fi, a drive with no
 * signal), the VIN waits and the upload worker asks again once it's online, before it uploads, so
 * the trips recorded meanwhile go up already named.
 */
object VehicleNaming {
    /** Whether [vin] would rename the vehicle (it's new, and nobody typed a name). */
    fun wanted(c: Context, vin: String): Boolean {
        val now = Prefs.config(c)
        if (now.vehicleVin.equals(vin, ignoreCase = true)) return false
        return !(now.vehicle.isNotBlank() && now.vehicleVin.isBlank())
    }

    /**
     * Looks [vin] up and saves the name. Blocking. Returns the name, or null when it couldn't (then
     * the VIN is kept for [retry]) or shouldn't (someone typed a name meanwhile).
     */
    fun lookUp(c: Context, vin: String): String? {
        if (!wanted(c, vin)) return null
        val cfg = Prefs.config(c)
        val named = VehicleLookup.name(cfg.serverUrl, cfg.deviceToken, vin)
        if (named == null) {
            Prefs.setPendingVin(c, vin)
            return null
        }
        Prefs.setPendingVin(c, "")
        val latest = Prefs.config(c)
        if (latest.vehicle.isNotBlank() && latest.vehicleVin.isBlank()) return null // typed meanwhile
        runCatching { Prefs.saveConfig(c, JSONObject(latest.json.toString()).put("vehicle", named).put("vehicleVin", vin).toString()) }
        return named
    }

    /**
     * Tries a waiting VIN again, and names the finished recordings on this phone that were made with
     * it while the name was unknown. Blocking; the upload worker calls it before uploading.
     */
    fun retry(c: Context) {
        val vin = Prefs.pendingVin(c)
        if (vin.isBlank()) return
        if (!wanted(c, vin)) {
            Prefs.setPendingVin(c, "")
            return
        }
        val named = lookUp(c, vin) ?: return
        val store = Prefs.store(c)
        for (id in store.ids()) {
            if (id == RecorderService.activeId) continue
            val meta = runCatching { store.readMeta(id) }.getOrNull() ?: continue
            if (meta.optString("vehicle").isNotBlank() || meta.optString("status") == "recording") continue
            val readVin = meta.optJSONObject("summary")?.optJSONObject("obd")?.optJSONObject("discovery")
                ?.optJSONObject("vehicleInfo")?.optString("vin").orEmpty()
            if (!readVin.equals(vin, ignoreCase = true)) continue
            meta.put("vehicle", named)
            store.writeMeta(id, meta)
        }
    }
}
