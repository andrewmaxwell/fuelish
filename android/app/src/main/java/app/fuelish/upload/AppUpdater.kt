package app.fuelish.upload

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import app.fuelish.Prefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * In-app updates for a sideloaded app: the server holds the latest release APK (tools/publish-apk.sh),
 * the app checks when it opens, and one tap downloads it, checks its SHA-256 and hands it to Android's
 * installer, which asks to confirm. Android also checks it's signed with the same key as this install.
 */
object AppUpdater {
    data class Available(val versionCode: Long, val versionName: String, val sha256: String, val bytes: Long)

    sealed class State {
        data object None : State()
        data class Ready(val update: Available) : State()
        data class Downloading(val update: Available, val fraction: Float) : State()
        data class Failed(val update: Available, val message: String) : State()
    }

    val state = MutableStateFlow<State>(State.None)
    private var lastCheckMs = 0L

    private fun installed(c: Context): Long = c.packageManager.getPackageInfo(c.packageName, 0).longVersionCode

    /** Debug builds are signed with another key, so a release can't install over them: never offer. */
    private fun isDebug(c: Context) = c.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    /** Asks the server for the latest build, at most every 30 minutes unless [force]. Quiet on failure. */
    suspend fun check(c: Context, force: Boolean = false) {
        if (isDebug(c) || state.value is State.Downloading) return
        val now = System.currentTimeMillis()
        if (!force && now - lastCheckMs < 30 * 60_000) return
        val cfg = Prefs.config(c)
        if (cfg.serverUrl.isBlank() || cfg.deviceToken.isBlank()) return
        lastCheckMs = now
        val latest = withContext(Dispatchers.IO) {
            runCatching {
                val conn = URL("${cfg.serverUrl}/api/v1/app/latest").openConnection() as HttpURLConnection
                try {
                    conn.connectTimeout = 10_000
                    conn.readTimeout = 10_000
                    conn.setRequestProperty("Authorization", "Bearer ${cfg.deviceToken}")
                    if (conn.responseCode != 200) return@runCatching null
                    JSONObject(conn.inputStream.bufferedReader().readText())
                } finally {
                    conn.disconnect()
                }
            }.getOrNull()
        } ?: return
        val code = latest.optLong("versionCode")
        state.value = if (code > installed(c)) {
            State.Ready(Available(code, latest.optString("versionName"), latest.optString("sha256"), latest.optLong("bytes")))
        } else {
            State.None
        }
    }

    /**
     * Downloads (or reuses an already-downloaded copy of) [u], checks it, and opens Android's installer.
     * The first time, Android needs "Install unknown apps" allowed for Fuelish: this opens that setting
     * instead, and the next tap continues.
     */
    suspend fun install(c: Context, u: Available) {
        if (!c.packageManager.canRequestPackageInstalls()) {
            c.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${c.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            return
        }
        val cfg = Prefs.config(c)
        val dir = File(c.cacheDir, "updates").apply { mkdirs() }
        val file = File(dir, "fuelish-${u.versionCode}.apk")
        dir.listFiles()?.filter { it != file }?.forEach { it.delete() } // older downloads
        state.value = State.Downloading(u, 0f)
        val problem = withContext(Dispatchers.IO) {
            try {
                if (!(file.exists() && sha256(file) == u.sha256)) {
                    val conn = URL("${cfg.serverUrl}/api/v1/app/apk/${u.versionCode}").openConnection() as HttpURLConnection
                    try {
                        conn.connectTimeout = 15_000
                        conn.readTimeout = 60_000
                        conn.setRequestProperty("Authorization", "Bearer ${cfg.deviceToken}")
                        if (conn.responseCode != 200) return@withContext "The server answered HTTP ${conn.responseCode}."
                        val part = File(dir, file.name + ".part")
                        var got = 0L
                        conn.inputStream.use { input ->
                            part.outputStream().use { out ->
                                val buf = ByteArray(64 * 1024)
                                while (true) {
                                    val n = input.read(buf)
                                    if (n < 0) break
                                    out.write(buf, 0, n)
                                    got += n
                                    if (u.bytes > 0) state.value = State.Downloading(u, (got.toFloat() / u.bytes).coerceAtMost(1f))
                                }
                            }
                        }
                        part.renameTo(file)
                    } finally {
                        conn.disconnect()
                    }
                    if (sha256(file) != u.sha256) {
                        file.delete()
                        return@withContext "The download was damaged. Try again."
                    }
                }
                null
            } catch (e: Exception) {
                "Couldn't download it (${e.message ?: e.javaClass.simpleName})."
            }
        }
        if (problem != null) {
            state.value = State.Failed(u, problem)
            return
        }
        state.value = State.Ready(u)
        // A recording may have started while it downloaded (the car connected): installing now would
        // end it. The banner offers the update again after the drive.
        if (app.fuelish.RecorderService.activeId != null) return
        val uri = FileProvider.getUriForFile(c, "${c.packageName}.updates", file)
        c.startActivity(
            Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    private fun sha256(f: File): String {
        val d = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                d.update(buf, 0, n)
            }
        }
        return d.digest().joinToString("") { "%02x".format(it) }
    }
}
