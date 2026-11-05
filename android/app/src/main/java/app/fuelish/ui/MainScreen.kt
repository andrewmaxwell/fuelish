package app.fuelish.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.fuelish.Prefs
import app.fuelish.RecorderService
import app.fuelish.RecorderState
import app.fuelish.auto.CarBluetooth
import app.fuelish.upload.UploadWorker
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

val PERMISSIONS = arrayOf(
    Manifest.permission.ACCESS_FINE_LOCATION,
    Manifest.permission.ACCESS_COARSE_LOCATION,
    Manifest.permission.BLUETOOTH_CONNECT,
    Manifest.permission.POST_NOTIFICATIONS,
)

@Composable
fun MainScreen(openSettings: () -> Unit, showTrips: () -> Unit) {
    val ctx = LocalContext.current
    val st by RecorderState.status.collectAsStateWithLifecycle()
    val up by RecorderState.upload.collectAsStateWithLifecycle()
    val pm = ctx.getSystemService(PowerManager::class.java)

    // Re-read setup state whenever we come back to the screen (e.g. from system settings) and every few seconds.
    var refresh by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        refresh++
        onPauseOrDispose { }
    }
    LaunchedEffect(Unit) {
        while (true) {
            delay(3000)
            refresh++
        }
    }
    val cfg = remember(refresh) { Prefs.config(ctx) }
    val missing = remember(refresh) { PERMISSIONS.filter { ctx.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED } }
    val batteryOk = remember(refresh) { pm.isIgnoringBatteryOptimizations(ctx.packageName) }
    val bgLocationOk = remember(refresh) { CarBluetooth.canStartInBackground(ctx) }
    var storage by remember { mutableLongStateOf(0L) }
    LaunchedEffect(refresh) { storage = Prefs.store(ctx).bytesUsed() }

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh++ }
    val bgLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { refresh++ }

    val locationOk = Manifest.permission.ACCESS_FINE_LOCATION !in missing
    val serverOk = cfg.serverUrl.isNotBlank() && cfg.deviceToken.isNotBlank()
    val auto = cfg.auto
    val autoOn = auto.optBoolean("enabled") && auto.optString("carAddress").isNotBlank()
    val obdChosen = cfg.obd.optString("deviceAddress").isNotBlank()
    val onWifi = remember(refresh) {
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        cm.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) == true
    }

    Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = showTrips) { Text("‹ Trips") }
            Column(Modifier.weight(1f)) {
                Text("Recorder", style = MaterialTheme.typography.headlineSmall)
                Muted(cfg.vehicle)
            }
            TextButton(onClick = openSettings) { Text("Settings") }
        }
        Spacer(Modifier.height(8.dp))

        val setupDone = missing.isEmpty() && batteryOk && serverOk && obdChosen && (!autoOn || bgLocationOk)
        // While setup is unfinished it comes first; afterwards it disappears.
        if (setupDone || st.recording) {
            if (st.recording) RecordingCard(st) else IdleCard(locationOk, autoOn, auto.optString("carName"), st.stopping)
        }
        if (!setupDone) {
            Section("Setup") {
                SetupRow(
                    missing.isEmpty(), "Permissions",
                    if (missing.isEmpty()) "Granted" else "Needed: " + missing.map(::permissionLabel).distinct().joinToString(", "),
                    "Grant",
                ) { permLauncher.launch(PERMISSIONS) }
                SetupRow(batteryOk, "Unrestricted battery", "Keeps recording and uploads running with the screen off", "Allow") {
                    @SuppressLint("BatteryLife")
                    val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.packageName))
                    ctx.startActivity(i)
                }
                SetupRow(serverOk, "Upload server", if (serverOk) cfg.serverUrl.removePrefix("https://") else "Where recordings are sent", "Set up", openSettings)
                SetupRow(
                    obdChosen, "OBD adapter",
                    if (obdChosen) cfg.obd.optString("deviceName") else "Optional. Pair the OBDLink, then choose it here",
                    "Choose", openSettings,
                )
                if (autoOn) {
                    SetupRow(bgLocationOk, "Location all the time", "Lets auto-record start while the phone is in your pocket", "Allow") {
                        bgLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                    }
                }
            }
        }

        if (!setupDone && !st.recording) IdleCard(locationOk, autoOn, auto.optString("carName"), st.stopping)
        if (st.recording) LiveDetails(st)

        Section("Uploads") {
            // Waiting covers chunks still to send and finished trips the server hasn't confirmed yet
            // (final details or the completeness check), not just chunk files.
            val waiting = up.waiting
            val uploadsOn = cfg.upload.optBoolean("enabled", true)
            val what = listOfNotNull(
                if (up.pending > 0) "${up.pending} chunk${if (up.pending == 1) "" else "s"}" else null,
                if (up.pending == 0 && up.unconfirmed > 0) "${up.unconfirmed} trip${if (up.unconfirmed == 1) "" else "s"} to finish" else null,
            ).joinToString()
            Text(
                when {
                    !waiting -> "Everything is on the server"
                    !uploadsOn -> "$what recorded on this phone; uploads are turned off"
                    !serverOk -> "$what will upload once the server is set up"
                    up.running -> "Uploading $what…"
                    onWifi || cfg.upload.optBoolean("allowCellular") -> "$what waiting to upload"
                    else -> "$what waiting for Wi-Fi"
                },
                style = MaterialTheme.typography.bodyLarge,
            )
            if (up.attention.isNotEmpty()) {
                Text(
                    "The server is missing parts of ${up.attention.size} trip${if (up.attention.size == 1) "" else "s"} that this phone no longer has: " +
                        up.attention.entries.joinToString("; ") { (id, seqs) -> "$id (part${if (seqs.size == 1) "" else "s"} ${seqs.joinToString(", ")})" } +
                        ". Those parts can't be recovered; the rest of each trip stays on this phone.",
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            if (up.lastResult.isNotEmpty()) {
                Muted("Last upload: " + up.lastResult + " (" + DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(up.lastAtMs)) + ")")
            }
            Muted("On this phone: ${mb(storage)}." + if (cfg.upload.optBoolean("deleteAfterUpload", true)) " Deleted once the server confirms it has everything." else " Kept after upload (keep-local-copy is on).")
            if (waiting && serverOk && uploadsOn) {
                Spacer(Modifier.height(4.dp))
                OutlinedButton(onClick = { UploadWorker.enqueue(ctx, cellular = true) }) {
                    Text(if (onWifi) "Upload now" else "Upload now over mobile data")
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun IdleCard(locationOk: Boolean, autoOn: Boolean, carName: String, stopping: Boolean) {
    val ctx = LocalContext.current
    var note by remember { mutableStateOf("") }
    Section {
        Text(if (stopping) "Saving recording…" else "Not recording", style = MaterialTheme.typography.titleLarge)
        Muted(
            when {
                !locationOk -> "Grant permissions above to start recording."
                autoOn -> "Starts automatically when your phone connects to $carName."
                else -> "Tap Start, or turn on auto-record in Settings."
            },
        )
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(
            note, { note = it }, Modifier.fillMaxWidth(), singleLine = true,
            label = { Text("Note for this recording (optional)") },
        )
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = { RecorderService.start(ctx, note); note = "" },
            enabled = locationOk && !stopping,
            modifier = Modifier.fillMaxWidth().height(56.dp),
        ) { Text("Start recording", style = MaterialTheme.typography.titleMedium) }
    }
}

@Composable
private fun RecordingCard(st: app.fuelish.RecorderStatus) {
    val ctx = LocalContext.current
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtimeNanos()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = SystemClock.elapsedRealtimeNanos()
            delay(1000)
        }
    }
    val auto = st.trigger != RecorderService.TRIGGER_MANUAL
    Section {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("●  ", color = MaterialTheme.colorScheme.error)
            Text("Recording", style = MaterialTheme.typography.titleLarge)
        }
        Muted(if (auto) "Started automatically. Stops on its own after you park." else "Started by you. Tap Stop when you're done.")
        Text(
            elapsed((now - st.startedElapsedNs) / 1_000_000_000),
            style = MaterialTheme.typography.displayMedium.copy(fontFeatureSettings = "tnum"), // digits don't jitter
            modifier = Modifier.padding(vertical = 8.dp),
        )
        val acc = st.sensorRates["s:acc"]?.let { "%.0f Hz".format(it) } ?: "–"
        val bad = MaterialTheme.colorScheme.error
        Line("GPS", st.gps.substringBefore(" ·").ifEmpty { "waiting" })
        Line("Motion sensors", acc)
        Line("OBD", obdSummary(st.obd))
        Line("Dropped data", if (st.drops == 0L) "none" else "%,d records".format(st.drops), if (st.drops > 0) bad else Color.Unspecified)
        if (st.writerError.isNotEmpty()) Text("Storage error: ${st.writerError}", color = bad)
        st.problems.forEach { Text(it, color = bad, style = MaterialTheme.typography.bodySmall) }
        Spacer(Modifier.height(12.dp))
        Button(
            onClick = { RecorderService.stop(ctx) },
            enabled = !st.stopping,
            modifier = Modifier.fillMaxWidth().height(56.dp),
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
        ) { Text(if (st.stopping) "Saving…" else "Stop recording", style = MaterialTheme.typography.titleMedium) }
    }
}

private fun obdSummary(o: app.fuelish.obd.ObdStatus) = when (o.state) {
    "polling" -> "%.0f readings/s".format(o.requestsPerSec * maxOf(o.maxBatch, 1)).takeIf { o.requestsPerSec > 0 } ?: "reading"
    "off" -> if (o.detail.isNotEmpty()) o.detail else "off"
    "waiting_vehicle" -> "waiting for car"
    "connecting" -> "connecting…"
    "disconnected" -> "reconnecting…"
    else -> o.state.replace('_', ' ')
}

@Composable
private fun LiveDetails(st: app.fuelish.RecorderStatus) {
    var open by remember { mutableStateOf(false) }
    Section {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Live details", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = { open = !open }) { Text(if (open) "Hide" else "Show") }
        }
        if (!open) return@Section
        Muted(st.gps)
        Muted(st.battery)
        Line("Records", "%,d".format(st.records))
        Line("Saved", "${mb(st.gzBytes)} in ${st.chunks} chunks")
        val o = st.obd
        if (o.state != "off") {
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            Text("OBD", style = MaterialTheme.typography.titleSmall)
            if (o.detail.isNotEmpty()) Muted(o.detail)
            if (o.adapter.isNotEmpty()) Line("Adapter", o.adapter)
            if (o.protocol.isNotEmpty()) Line("Protocol", o.protocol)
            if (o.vin.isNotEmpty()) Line("VIN", o.vin)
            if (o.supportedPids > 0) Line("Supported signals", o.supportedPids.toString())
            if (o.maxBatch > 0) Line("Signals per request", o.maxBatch.toString())
            if (o.requestsPerSec > 0) Line("Requests/s · latency", "%.1f · %.0f ms".format(o.requestsPerSec, o.meanLatencyMs))
            if (o.adapterVolts.isNotEmpty()) Line("Car battery", o.adapterVolts)
            o.values.toSortedMap().forEach { (k, v) -> Line(k, v) }
        }
        HorizontalDivider(Modifier.padding(vertical = 8.dp))
        Text("Samples in the last second", style = MaterialTheme.typography.titleSmall)
        st.sensorRates.toSortedMap().forEach { (k, v) -> Line(k, "%.0f".format(v)) }
    }
}
