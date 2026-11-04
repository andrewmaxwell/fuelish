package app.fuelish

import android.content.Context
import app.fuelish.obd.ObdStatus
import app.fuelish.record.RecordingStore
import kotlinx.coroutines.flow.MutableStateFlow
import java.io.File
import java.util.UUID

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

    fun config(c: Context): Config = runCatching { Config.parse(configJson(c)) }.getOrElse { Config.parse(null) }

    fun saveConfig(c: Context, json: String) {
        Config.parse(json) // validate
        sp(c).edit().putString("config", json).apply()
    }

    fun deviceId(c: Context): String {
        val p = sp(c)
        return p.getString("deviceId", null) ?: UUID.randomUUID().toString().also { p.edit().putString("deviceId", it).apply() }
    }

    fun store(c: Context): RecordingStore {
        val base = c.getExternalFilesDir(null) ?: c.filesDir
        return RecordingStore(File(base, "recordings"))
    }
}
