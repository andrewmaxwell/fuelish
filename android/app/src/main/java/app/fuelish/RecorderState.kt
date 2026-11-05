package app.fuelish

import android.content.Context
import app.fuelish.obd.ObdStatus
import app.fuelish.record.RecordingStore
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
            for (k in listOf("serverUrl", "deviceToken", "vehicle")) (keep.opt(k) as? String)?.let { d.json.put(k, it) }
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

    fun store(c: Context): RecordingStore {
        val base = c.getExternalFilesDir(null) ?: c.filesDir
        return RecordingStore(File(base, "recordings"))
    }
}
