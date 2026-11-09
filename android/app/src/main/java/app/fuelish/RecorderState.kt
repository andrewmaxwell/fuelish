package app.fuelish

import android.content.Context
import app.fuelish.obd.ObdStatus
import app.fuelish.record.RecordingStore
import app.fuelish.record.UploadTarget
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File
import java.util.UUID
import org.json.JSONObject

data class RecorderStatus(
    val recording: Boolean = false,
    val stopping: Boolean = false,
    val recordingId: String = "",
    val trigger: String = "",
    val startedElapsedNs: Long = 0,
    val records: Long = 0,
    val drops: Long = 0,
    val queue: Int = 0,
    val chunks: Int = 0,
    val gzBytes: Long = 0,
    val rawBytes: Long = 0,
    val sensorRates: Map<String, Double> = emptyMap(),
    val gps: String = "",
    val obd: ObdStatus = ObdStatus(),
    val battery: String = "",
    val problems: List<String> = emptyList(),
    val writerError: String = "",
)

/**
 * [pending]: finished chunks not yet acknowledged. [unconfirmed]: finished recordings the server
 * hasn't confirmed in full (metadata or verification still to go). [attention]: recordings with
 * parts the server lacks and the phone no longer has: id -> missing chunk numbers.
 */
data class UploadStatus(
    val running: Boolean = false,
    val lastResult: String = "",
    val lastAtMs: Long = 0,
    val pending: Int = 0,
    val unconfirmed: Int = 0,
    val attention: Map<String, List<Int>> = emptyMap(),
    /** Recordings waiting because they belong to another account or server, or the server refused them. */
    val held: List<String> = emptyList(),
) {
    val waiting get() = pending > 0 || unconfirmed > 0
}

/** Process-wide state shared by the service, the upload worker and the UI. */
object RecorderState {
    val status = MutableStateFlow(RecorderStatus())
    val upload = MutableStateFlow(UploadStatus())
}

object Prefs {
    private fun sp(c: Context) = c.getSharedPreferences("fuelish", Context.MODE_PRIVATE)

    fun configJson(c: Context): String? = sp(c).getString("config", null)

    /**
     * The saved config. Saves are checked, so this is the last one that worked; one saved before
     * checks existed and broken falls back to the defaults, keeping the sign-in and chosen devices.
     */
    fun config(c: Context): Config {
        val stored = configJson(c)
        runCatching { return Config.parseChecked(stored) }
        val keep = runCatching { Config.parse(stored).json }.getOrNull()
        val d = Config.parse(null)
        if (keep != null) {
            for (k in listOf("serverUrl", "deviceToken", "vehicle", "vehicleVin")) (keep.opt(k) as? String)?.let { d.json.put(k, it) }
            for ((block, keys) in listOf("obd" to listOf("deviceAddress", "deviceName"), "auto" to listOf("carAddress", "carName", "enabled"))) {
                val from = keep.opt(block) as? JSONObject ?: continue
                for (k in keys) from.opt(k)?.let { v -> if (v is String || v is Boolean) d.json.getJSONObject(block).put(k, v) }
            }
        }
        return runCatching { Config.parseChecked(d.json.toString()) }.getOrElse { Config.parse(null) }
    }

    /** Throws IllegalArgumentException (or a JSON error) saying what's wrong, and saves nothing. */
    fun saveConfig(c: Context, json: String) {
        Config.parseChecked(json)
        sp(c).edit().putString("config", json).apply()
        // Auto-record or the adapter may have changed: drive detection follows.
        runCatching { app.fuelish.auto.DriveDetect.sync(c) }
    }

    fun deviceId(c: Context): String {
        val p = sp(c)
        return p.getString("deviceId", null) ?: UUID.randomUUID().toString().also { p.edit().putString("deviceId", it).apply() }
    }

    /**
     * A one-time pass for "tap to record" notifications. MainActivity is exported (it's the
     * launcher), so any app could send it a start-recording extra; only an intent carrying the pass
     * we put in our own notification starts a recording. Using it clears it.
     */
    fun newStartPass(c: Context): String = UUID.randomUUID().toString().also { sp(c).edit().putString("startPass", it).apply() }

    fun takeStartPass(c: Context, pass: String?): Boolean {
        val p = sp(c)
        val want = p.getString("startPass", null) ?: return false
        if (pass == null || pass != want) return false
        p.edit().remove("startPass").apply()
        return true
    }

    /**
     * Where a recording started now uploads: the configured server and key, with the account the
     * server last said that key belongs to (learned on each upload; unknown until the first).
     */
    fun uploadTarget(c: Context): UploadTarget {
        val cfg = config(c)
        val t = UploadTarget.of(cfg.serverUrl, cfg.deviceToken)
        val known = sp(c).getString("uploadTarget", null)?.let { runCatching { UploadTarget.fromJson(JSONObject(it)) }.getOrNull() }
        return if (known != null && known.server == t.server && known.key == t.key) known else t
    }

    fun rememberUploadTarget(c: Context, t: UploadTarget) {
        sp(c).edit().putString("uploadTarget", t.toJson().toString()).apply()
    }

    /** Whether the chosen car's Bluetooth was last seen connected (kept across app restarts). */
    fun carConnected(c: Context) = sp(c).getBoolean("carConnected", false)
    fun setCarConnected(c: Context, connected: Boolean) = sp(c).edit().putBoolean("carConnected", connected).apply()

    /**
     * Bluetooth devices connected right now, as far as the connect/disconnect broadcasts say: address ->
     * when it connected. Entries from before the phone last started are dropped (no disconnect comes
     * across a restart).
     */
    fun btConnected(c: Context): Set<String> {
        val bootWall = System.currentTimeMillis() - android.os.SystemClock.elapsedRealtime()
        return sp(c).getStringSet("btConnected", emptySet()).orEmpty()
            .mapNotNull { e -> e.split('|').takeIf { it.size == 2 && (it[1].toLongOrNull() ?: 0) > bootWall }?.get(0) }
            .toSet()
    }

    @Synchronized
    fun setBtConnected(c: Context, address: String, connected: Boolean) {
        val now = sp(c).getStringSet("btConnected", emptySet()).orEmpty().filterNot { it.startsWith("$address|", ignoreCase = true) }.toMutableSet()
        if (connected) now += "$address|${System.currentTimeMillis()}"
        sp(c).edit().putStringSet("btConnected", now).apply()
    }

    /** A car Bluetooth seen during a drive, offered for auto-record: name to address. Null when none. */
    fun autoSuggestion(c: Context): Pair<String, String>? {
        val a = sp(c).getString("autoSuggestAddr", null) ?: return null
        return (sp(c).getString("autoSuggestName", null) ?: "your car") to a
    }

    fun setAutoSuggestion(c: Context, name: String, address: String) =
        sp(c).edit().putString("autoSuggestName", name).putString("autoSuggestAddr", address).apply()

    /** Answers the suggestion; a "no" means that device is never suggested again. */
    fun answerAutoSuggestion(c: Context, accepted: Boolean) {
        val a = sp(c).getString("autoSuggestAddr", null)
        val e = sp(c).edit().remove("autoSuggestName").remove("autoSuggestAddr")
        if (!accepted && a != null) e.putStringSet("autoDeclined", autoDeclined(c) + a.uppercase())
        e.apply()
    }

    fun autoDeclined(c: Context): Set<String> = sp(c).getStringSet("autoDeclined", emptySet()).orEmpty()

    /** Set up without an OBD adapter on purpose: setup stops asking for one. */
    fun skippedAdapter(c: Context) = sp(c).getBoolean("skippedAdapter", false)
    fun setSkippedAdapter(c: Context, skipped: Boolean) = sp(c).edit().putBoolean("skippedAdapter", skipped).apply()

    /** The server turned this phone's upload key away (401): recordings wait until someone signs in again. */
    fun signInNeeded(c: Context) = sp(c).getBoolean("signInNeeded", false)
    fun setSignInNeeded(c: Context, needed: Boolean) = sp(c).edit().putBoolean("signInNeeded", needed).apply()

    /**
     * Whether recording starts by itself ("auto") or with Start/Stop ("manual"); "" until setup asks.
     * Turning auto-record on in Settings counts as choosing it.
     */
    fun recordMode(c: Context): String {
        val a = config(c).auto
        if (a.optBoolean("enabled") && a.optString("carAddress").isNotBlank()) return "auto"
        return sp(c).getString("recordMode", "").orEmpty()
    }
    fun setRecordMode(c: Context, mode: String) = sp(c).edit().putString("recordMode", mode).apply()

    /** The adapter address that passed the parked connection test in setup ("" if none has). */
    fun adapterChecked(c: Context) = sp(c).getString("adapterChecked", "").orEmpty()
    fun setAdapterChecked(c: Context, address: String) = sp(c).edit().putString("adapterChecked", address).apply()
    /** The adapter whose test was put off ("test on the first drive"); setup doesn't hold up on it. */
    fun adapterTestSkipped(c: Context) = sp(c).getString("adapterTestSkipped", "").orEmpty()
    fun setAdapterTestSkipped(c: Context, address: String) = sp(c).edit().putString("adapterTestSkipped", address).apply()

    /** A VIN read on a drive whose name lookup failed (no signal): looked up again once online. */
    fun pendingVin(c: Context) = sp(c).getString("pendingVin", "").orEmpty()
    fun setPendingVin(c: Context, vin: String) = sp(c).edit().putString("pendingVin", vin).apply()
    /** The check-engine light as last read on a drive, so a light that stays on isn't announced every drive. */
    fun milOn(c: Context) = sp(c).getBoolean("milOn", false)
    fun setMilOn(c: Context, on: Boolean) = sp(c).edit().putBoolean("milOn", on).apply()
    /** Latest regional gas prices for the spoken summary: {"fetchedMs", "prices": {region: $/gal}} (see GasPrice). */
    fun gasPrices(c: Context): String? = sp(c).getString("gasPrices", null)
    fun setGasPrices(c: Context, json: String) = sp(c).edit().putString("gasPrices", json).apply()
    /** The VIN the adapter read most recently: the car the phone is in, or was in last. */
    fun lastVin(c: Context) = sp(c).getString("lastVin", "").orEmpty()
    fun setLastVin(c: Context, vin: String) = sp(c).edit().putString("lastVin", vin).apply()

    fun store(c: Context): RecordingStore {
        val base = c.getExternalFilesDir(null) ?: c.filesDir
        return RecordingStore(File(base, "recordings"))
    }
}
