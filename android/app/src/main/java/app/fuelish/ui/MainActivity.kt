package app.fuelish.ui

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.fuelish.Config
import app.fuelish.Prefs
import app.fuelish.RecorderService
import app.fuelish.RecorderState
import app.fuelish.auto.CarBluetooth
import app.fuelish.upload.UploadWorker
import kotlinx.coroutines.delay
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date
import java.util.concurrent.Executors

private val PERMISSIONS = arrayOf(
    Manifest.permission.ACCESS_FINE_LOCATION,
    Manifest.permission.ACCESS_COARSE_LOCATION,
    Manifest.permission.BLUETOOTH_CONNECT,
    Manifest.permission.POST_NOTIFICATIONS,
)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleStartTrigger(intent)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) {
                    var settings by remember { mutableStateOf(false) }
                    BackHandler(settings) { settings = false }
                    if (settings) SettingsScreen { settings = false } else MainScreen { settings = true }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleStartTrigger(intent)
    }

    /** Tapping the "Car connected: tap to record" notification lands here; we're in the foreground now. */
    private fun handleStartTrigger(i: Intent?) {
        val trigger = i?.getStringExtra(EXTRA_START_TRIGGER) ?: return
        i.removeExtra(EXTRA_START_TRIGGER)
        if (RecorderService.activeId == null && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            RecorderService.start(this, "", trigger)
        }
    }

    companion object {
        const val EXTRA_START_TRIGGER = "startTrigger"
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        Column(Modifier.padding(14.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
            Spacer(Modifier.height(6.dp))
            content()
        }
    }
}

@Composable
private fun Line(label: String, value: String, color: Color = Color.Unspecified) {
    Row(Modifier.fillMaxWidth().padding(vertical = 1.dp), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
        Text(value, fontSize = 13.sp, color = color, modifier = Modifier.padding(start = 12.dp))
    }
}

private fun mb(b: Long) = "%.1f MB".format(b / 1048576.0)

@Composable
private fun MainScreen(openSettings: () -> Unit) {
    val ctx = LocalContext.current
    val st by RecorderState.status.collectAsStateWithLifecycle()
    val up by RecorderState.upload.collectAsStateWithLifecycle()
    var note by remember { mutableStateOf("") }
    var refresh by remember { mutableIntStateOf(0) }
    var storageBytes by remember { mutableStateOf(0L) }
    var message by remember { mutableStateOf("") }
    val cfg = remember(refresh) { Prefs.config(ctx) }

    fun missingPerms() = PERMISSIONS.filter { ctx.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    var missing by remember { mutableStateOf(missingPerms()) }
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { missing = missingPerms() }
    val pm = ctx.getSystemService(PowerManager::class.java)
    var batteryExempt by remember { mutableStateOf(pm.isIgnoringBatteryOptimizations(ctx.packageName)) }

    LaunchedEffect(Unit) {
        while (true) {
            storageBytes = Prefs.store(ctx).bytesUsed()
            missing = missingPerms()
            batteryExempt = pm.isIgnoringBatteryOptimizations(ctx.packageName)
            delay(5000)
        }
    }
    // Ticks the elapsed-time display.
    var now by remember { mutableStateOf(SystemClock.elapsedRealtimeNanos()) }
    LaunchedEffect(st.recording) {
        while (st.recording) {
            now = SystemClock.elapsedRealtimeNanos()
            delay(1000)
        }
    }

    Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Column {
                Text("Fuelish", fontSize = 24.sp, fontWeight = FontWeight.Bold)
                Text(cfg.vehicle, color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
            }
            TextButton(onClick = openSettings, enabled = !st.recording) { Text("Settings") }
        }

        if (missing.isNotEmpty()) {
            Section("Permissions needed") {
                Text("Missing: " + missing.joinToString { it.substringAfterLast('.') }, fontSize = 13.sp)
                Text("Location is required. Bluetooth is needed for OBD. Notifications show the recording status.", fontSize = 12.sp)
                Button(onClick = { permLauncher.launch(PERMISSIONS) }) { Text("Grant permissions") }
            }
        }
        if (!batteryExempt) {
            Section("Battery optimization") {
                Text("Exempting Fuelish keeps recording and uploads running with the screen off.", fontSize = 13.sp)
                OutlinedButton(onClick = {
                    @SuppressLint("BatteryLife")
                    val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.packageName))
                    ctx.startActivity(i)
                }) { Text("Allow unrestricted battery") }
            }
        }

        if (!st.recording) {
            OutlinedTextField(
                value = note, onValueChange = { note = it }, modifier = Modifier.fillMaxWidth(),
                label = { Text("Note (phone mount, passengers, route…)") }, singleLine = true,
            )
            Spacer(Modifier.height(8.dp))
        }
        val canStart = ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        Button(
            onClick = { if (st.recording) RecorderService.stop(ctx) else RecorderService.start(ctx, note) },
            enabled = !st.stopping && (st.recording || canStart),
            modifier = Modifier.fillMaxWidth().height(64.dp),
            colors = if (st.recording) ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error) else ButtonDefaults.buttonColors(),
        ) {
            Text(if (st.stopping) "Stopping…" else if (st.recording) "Stop recording" else "Start recording", fontSize = 18.sp)
        }

        val auto = cfg.auto
        if (auto.optBoolean("enabled")) {
            val bg = CarBluetooth.canStartInBackground(ctx)
            Text(
                "Auto-record with ${auto.optString("carName").ifEmpty { "car" }}: on" +
                    if (bg) "" else " · needs location \"Allow all the time\" (Settings)",
                fontSize = 12.sp,
                color = if (bg) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = 4.dp),
            )
        }

        if (st.recording) {
            Section("Recording") {
                val secs = (now - st.startedElapsedNs) / 1_000_000_000
                val hours = secs / 3600.0
                Line("ID", st.recordingId)
                Line("Started by", if (st.trigger == RecorderService.TRIGGER_MANUAL) "you" else "car Bluetooth (stops automatically)")
                Line("Elapsed", "%d:%02d:%02d".format(secs / 3600, secs / 60 % 60, secs % 60))
                Line("Records", "%,d".format(st.records))
                Line("Dropped", "%,d".format(st.drops), if (st.drops > 0) MaterialTheme.colorScheme.error else Color.Unspecified)
                Line("Write queue", "%,d".format(st.queue))
                Line("Chunks closed", st.chunks.toString())
                Line("Compressed / raw", "${mb(st.gzBytes)} / ${mb(st.rawBytes)}")
                if (hours > 0.02 && st.gzBytes > 0) Line("Compressed per hour", mb((st.gzBytes / hours).toLong()))
                if (st.writerError.isNotEmpty()) Text("Writer error: ${st.writerError}", color = MaterialTheme.colorScheme.error)
                st.problems.forEach { Text("⚠ $it", fontSize = 12.sp, color = MaterialTheme.colorScheme.error) }
            }
            Section("GPS") { Text(st.gps, fontSize = 13.sp) }
            Section("Sensor rates (samples in the last second)") {
                st.sensorRates.toSortedMap().forEach { (k, v) -> Line(k, "%.0f".format(v)) }
            }
            Section("Battery") { Text(st.battery, fontSize = 13.sp) }
        }

        Section("OBD adapter") {
            val o = st.obd
            Line("Adapter", cfg.obd.optString("deviceName").ifEmpty { cfg.obd.optString("deviceAddress").ifEmpty { "none selected" } })
            Line("State", o.state)
            if (o.detail.isNotEmpty()) Text(o.detail, fontSize = 12.sp)
            if (o.adapter.isNotEmpty()) Line("Firmware", o.adapter)
            if (o.protocol.isNotEmpty()) Line("Protocol", o.protocol)
            if (o.vin.isNotEmpty()) Line("VIN", o.vin)
            if (o.supportedPids > 0) Line("Supported PIDs", o.supportedPids.toString())
            if (o.maxBatch > 0) Line("PIDs per request", o.maxBatch.toString())
            if (o.requestsPerSec > 0) Line("Requests/s · latency", "%.1f · %.0f ms".format(o.requestsPerSec, o.meanLatencyMs))
            if (o.adapterVolts.isNotEmpty()) Line("Adapter voltage", o.adapterVolts)
            o.values.toSortedMap().forEach { (k, v) -> Line(k, v) }
        }

        Section("Upload") {
            Line("Server", cfg.serverUrl.ifEmpty { "not set" })
            Line("Pending chunks", up.pending.toString())
            if (up.lastAtMs > 0) Line("Last attempt", DateFormat.getTimeInstance().format(Date(up.lastAtMs)))
            if (up.lastResult.isNotEmpty()) Text(up.lastResult, fontSize = 12.sp)
            Row {
                OutlinedButton(onClick = { UploadWorker.enqueue(ctx); message = "Upload queued (runs when online)" }) { Text("Upload now") }
            }
        }

        Section("Storage on phone") {
            Line("Recordings", mb(storageBytes))
            Text("Files: Android/data/${ctx.packageName}/files/recordings", fontSize = 12.sp)
            OutlinedButton(onClick = {
                Executors.newSingleThreadExecutor().execute {
                    val n = Prefs.store(ctx).deleteUploaded(RecorderService.activeId)
                    message = "Deleted $n fully uploaded recording(s) from the phone"
                    storageBytes = Prefs.store(ctx).bytesUsed()
                }
            }) { Text("Delete uploaded local copies") }
        }
        if (message.isNotEmpty()) Text(message, fontSize = 12.sp)
        Spacer(Modifier.height(24.dp))
    }
}

@SuppressLint("MissingPermission")
@Composable
private fun SettingsScreen(close: () -> Unit) {
    val ctx = LocalContext.current
    val initial = remember { JSONObject(Prefs.config(ctx).json.toString()) }
    var server by remember { mutableStateOf(initial.optString("serverUrl")) }
    var token by remember { mutableStateOf(initial.optString("deviceToken")) }
    var json by remember { mutableStateOf(initial.toString(2)) }
    var error by remember { mutableStateOf("") }
    var bgLocation by remember { mutableStateOf(CarBluetooth.canStartInBackground(ctx)) }
    val bgLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        bgLocation = CarBluetooth.canStartInBackground(ctx)
    }

    val bonded = remember {
        if (ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) emptyList()
        else ctx.getSystemService(BluetoothManager::class.java)?.adapter?.bondedDevices?.map { (it.name ?: "?") to it.address }
            ?.sortedByDescending { it.first.contains("OBD", ignoreCase = true) } ?: emptyList()
    }

    fun edit(block: JSONObject.() -> Unit) {
        try {
            json = JSONObject(json).apply(block).toString(2)
            error = ""
        } catch (e: Exception) {
            error = "Fix the JSON first: ${e.message}"
        }
    }

    Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Settings", fontSize = 22.sp, fontWeight = FontWeight.Bold)
            TextButton(onClick = close) { Text("Back") }
        }
        Section("Server") {
            OutlinedTextField(server, { server = it; edit { put("serverUrl", it.trim()) } }, Modifier.fillMaxWidth(),
                label = { Text("Server URL (https://fuelish.<you>.workers.dev)") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
            OutlinedTextField(token, { token = it; edit { put("deviceToken", it.trim()) } }, Modifier.fillMaxWidth(),
                label = { Text("Device token (DEVICE_TOKEN)") }, singleLine = true,
                visualTransformation = PasswordVisualTransformation())
        }
        Section("OBD adapter (pair it in Android Bluetooth settings first)") {
            if (bonded.isEmpty()) Text("No paired devices visible (Bluetooth off or permission missing).", fontSize = 13.sp)
            bonded.forEach { (name, addr) ->
                TextButton(onClick = { edit { getJSONObject("obd").put("deviceAddress", addr).put("deviceName", name) } }) {
                    Text("$name  $addr")
                }
            }
            val sel = runCatching { JSONObject(json).getJSONObject("obd") }.getOrNull()
            Text("Selected: ${sel?.optString("deviceName")} ${sel?.optString("deviceAddress")}", fontSize = 13.sp)
        }
        Section("Auto-record") {
            val auto = runCatching { JSONObject(json).getJSONObject("auto") }.getOrNull()
            val enabled = auto?.optBoolean("enabled") == true
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("Start when the car's Bluetooth connects", fontSize = 13.sp, modifier = Modifier.weight(1f))
                Switch(checked = enabled, onCheckedChange = { on -> edit { getJSONObject("auto").put("enabled", on) } })
            }
            Text(
                "Stops ${auto?.optInt("stopAfterCarDisconnectS")} s after the car disconnects, or after the car stops " +
                    "answering OBD for ${auto?.optInt("stopAfterEngineOffS")} s. Manual recordings are never stopped automatically.",
                fontSize = 12.sp,
            )
            Text("Car (not the OBD adapter):", fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
            val obdAddr = runCatching { JSONObject(json).getJSONObject("obd").optString("deviceAddress") }.getOrDefault("")
            bonded.filter { it.second != obdAddr }.forEach { (name, addr) ->
                TextButton(onClick = { edit { getJSONObject("auto").put("carAddress", addr).put("carName", name) } }) {
                    Text("$name  $addr")
                }
            }
            Text("Selected: ${auto?.optString("carName")} ${auto?.optString("carAddress")}", fontSize = 13.sp)
            if (bgLocation) {
                Text("Location: allowed all the time ✓", fontSize = 13.sp)
            } else {
                Text("Background starts need location set to \"Allow all the time\".", fontSize = 13.sp, color = MaterialTheme.colorScheme.error)
                OutlinedButton(onClick = { bgLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }) { Text("Allow all the time") }
            }
        }
        Section("All settings (JSON)") {
            Text("Sensor rates are Hz (0 = off, -1 = fastest). OBD PID lists are hex. Changes apply to the next recording.", fontSize = 12.sp)
            OutlinedTextField(json, { json = it }, Modifier.fillMaxWidth(),
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
        }
        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {
                try {
                    Prefs.saveConfig(ctx, json)
                    UploadWorker.schedulePeriodic(ctx)
                    close()
                } catch (e: Exception) {
                    error = "Invalid JSON: ${e.message}"
                }
            }) { Text("Save") }
            OutlinedButton(onClick = {
                json = JSONObject(Config.DEFAULTS).put("serverUrl", server).put("deviceToken", token).apply {
                    val o = runCatching { JSONObject(json).getJSONObject("obd") }.getOrNull()
                    if (o != null) getJSONObject("obd").put("deviceAddress", o.optString("deviceAddress")).put("deviceName", o.optString("deviceName"))
                }.toString(2)
            }) { Text("Reset to defaults") }
        }
        Spacer(Modifier.height(24.dp))
    }
}
