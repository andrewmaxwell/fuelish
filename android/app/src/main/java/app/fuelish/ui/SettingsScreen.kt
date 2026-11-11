package app.fuelish.ui

import android.Manifest
import android.annotation.SuppressLint
import android.widget.Toast
import android.bluetooth.BluetoothManager
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import app.fuelish.Config
import app.fuelish.Prefs
import app.fuelish.auto.CarBluetooth
import app.fuelish.upload.ServerCheck
import app.fuelish.upload.UploadWorker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Every change saves immediately; it applies to the next recording. */
@SuppressLint("MissingPermission")
@Composable
fun SettingsScreen(close: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var cfg by remember { mutableStateOf(JSONObject(Prefs.config(ctx).json.toString())) }
    fun update(block: JSONObject.() -> Unit) {
        val next = JSONObject(cfg.toString()).apply(block)
        // The simple controls can't produce a config the checks refuse, but never crash over one.
        try {
            Prefs.saveConfig(ctx, next.toString())
            cfg = next
        } catch (e: IllegalArgumentException) {
            Toast.makeText(ctx, "Not saved: ${e.message}", Toast.LENGTH_LONG).show()
        }
    }

    var refresh by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        refresh++
        onPauseOrDispose { }
    }
    val btOk = remember(refresh) { ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED }
    val bonded = remember(refresh) {
        if (!btOk) emptyList()
        else ctx.getSystemService(BluetoothManager::class.java)?.adapter?.bondedDevices
            ?.sortedWith(compareBy({ !CarBluetooth.looksLikeCar(it) }, { (it.name ?: "").lowercase() }))
            ?.map { (it.name ?: "Unnamed device") to it.address } ?: emptyList()
    }
    val bgLocationOk = remember(refresh) { CarBluetooth.canStartInBackground(ctx) }
    val bgLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { refresh++ }
    val activityOk = remember(refresh) { app.fuelish.auto.DriveDetect.permitted(ctx) }
    val activityLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        app.fuelish.auto.DriveDetect.sync(ctx)
        refresh++
    }

    val obd = cfg.getJSONObject("obd")
    val auto = cfg.getJSONObject("auto")
    var pairNote by remember { mutableStateOf("") }
    val pair = rememberAdapterPairing { name, problem ->
        pairNote = if (name != null) "Using $name." else problem
        cfg = JSONObject(Prefs.config(ctx).json.toString())
    }
    // The server and raw JSON are for whoever runs the server; everyone else never needs them.
    var advancedOpen by remember { mutableStateOf(false) }

    Column(Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = close) { Text("‹ Back") }
            Text("Settings", style = MaterialTheme.typography.headlineSmall)
        }
        Muted("Changes save automatically and apply to the next recording.", Modifier.padding(start = 12.dp, bottom = 4.dp))

        Section("Car") {
            // Typing a name makes it yours: a VIN read later won't rename it.
            SettingField(cfg.optString("vehicle"), "Vehicle") { v -> update { put("vehicle", v.trim()).put("vehicleVin", "") } }
            Muted(
                if (cfg.optString("vehicleVin").isNotBlank()) "Named from the car's VIN. Type to change it."
                else "Year, make and model. With an OBD adapter, Fuelish fills this in from the car on the first drive.",
                Modifier.padding(top = 4.dp),
            )
        }

        Section("OBD adapter") {
            Muted("Plug it in with the car on and press its button, then tap Find adapter. Or choose one that's already paired.")
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(onClick = { pairNote = ""; pair() }) { Text("Find adapter") }
                TextButton(onClick = { ctx.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) }) { Text("Bluetooth settings") }
            }
            if (pairNote.isNotEmpty()) Muted(pairNote)
            DeviceList(
                btOk, bonded, selected = obd.optString("deviceAddress"), noneLabel = "No adapter (phone sensors only)",
            ) { name, addr -> update { getJSONObject("obd").put("deviceAddress", addr).put("deviceName", name) } }
        }

        Section("Auto-record") {
            val on = auto.optBoolean("enabled")
            // With an adapter, a detected drive starts recording; the car's Bluetooth only makes it sooner.
            val hasAdapter = obd.optString("deviceAddress").isNotBlank()
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Record automatically", style = MaterialTheme.typography.bodyLarge)
                    Muted(
                        if (hasAdapter) "Starts when your phone notices you're driving (a minute or two in) and the adapter answers, " +
                            "and stops shortly after you park. Works in any car the adapter is plugged into."
                        else "Starts when your phone connects to the car's Bluetooth and stops about 10 seconds after you park.",
                    )
                }
                Switch(checked = on, onCheckedChange = { v -> update { getJSONObject("auto").put("enabled", v) } })
            }
            if (on) {
                Spacer(Modifier.height(8.dp))
                Text(if (hasAdapter) "Start sooner with your car's Bluetooth (optional)" else "Your car's Bluetooth", style = MaterialTheme.typography.titleSmall)
                if (hasAdapter) Muted("Recording then starts as soon as the phone connects to it, in that car.")
                DeviceList(
                    btOk, bonded.filter { it.second != obd.optString("deviceAddress") },
                    selected = auto.optString("carAddress"), noneLabel = if (hasAdapter) "None" else null,
                ) { name, addr -> update { getJSONObject("auto").put("carAddress", addr).put("carName", name) } }
                Spacer(Modifier.height(8.dp))
                SetupRow(
                    bgLocationOk, "Location all the time",
                    "Needed so recording can start while the phone is in your pocket", "Allow",
                ) { bgLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }
                if (hasAdapter) {
                    SetupRow(
                        activityOk, "Physical activity",
                        "Needed to notice when you start driving", "Allow",
                    ) { activityLauncher.launch(Manifest.permission.ACTIVITY_RECOGNITION) }
                }
            }
        }

        Section("During a drive") {
            Muted("Spoken through the car like navigation prompts, briefly lowering music. Nothing to look at.")
            val fb = cfg.getJSONObject("feedback")
            FeedbackSwitch("Recording sounds", "A chime when recording starts, and a spoken alert if the adapter disconnects or never connects.", fb.optBoolean("sounds", true)) { v ->
                update { getJSONObject("feedback").put("sounds", v) }
            }
            FeedbackSwitch("Summary when a drive ends", "Miles, time, gallons, mpg and what the gas cost, said when you switch the car off.", fb.optBoolean("summary", true)) { v ->
                update { getJSONObject("feedback").put("summary", v) }
            }
            FeedbackSwitch("Car warnings", "The check engine light coming on, the engine running hot, or the battery not charging.", fb.optBoolean("warnings", true)) { v ->
                update { getJSONObject("feedback").put("warnings", v) }
            }
            FeedbackSwitch("Idling tip", "At most once a drive: after three minutes idling at a standstill, what the wait has cost so far.", fb.optBoolean("tips", true)) { v ->
                update { getJSONObject("feedback").put("tips", v) }
            }
        }

        Section("Uploads") {
            val mobileData = cfg.getJSONObject("upload").optBoolean("mobileData", true)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Upload over mobile data", style = MaterialTheme.typography.bodyLarge)
                    Muted(
                        if (mobileData) "Trips upload as you drive, about 13 MB per hour of driving."
                        else "Trips wait for Wi-Fi. The recorder screen can still send them now over mobile data.",
                    )
                }
                Switch(checked = mobileData, onCheckedChange = { v ->
                    update { getJSONObject("upload").put("mobileData", v) }
                    UploadWorker.enqueue(ctx, replace = true)
                })
            }
        }

        AdvancedSection(cfg, advancedOpen, { advancedOpen = it }) { json ->
            Prefs.saveConfig(ctx, json)
            cfg = JSONObject(Prefs.config(ctx).json.toString())
        }
        if (advancedOpen || cfg.optString("serverUrl").isBlank()) {
        Section("Upload server") {
            var result by remember { mutableStateOf<ServerCheck.Result?>(null) }
            var checking by remember { mutableStateOf(false) }
            SettingField(cfg.optString("serverUrl"), "Server URL", KeyboardType.Uri) { v ->
                update { put("serverUrl", v.trim()) }
                result = null
            }
            Spacer(Modifier.height(8.dp))
            SettingField(cfg.optString("deviceToken"), "Device token", KeyboardType.Password, secret = true) { v ->
                update { put("deviceToken", v.trim()) }
                result = null
            }
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(enabled = !checking, onClick = {
                    checking = true
                    scope.launch {
                        result = withContext(Dispatchers.IO) { ServerCheck.check(cfg.optString("serverUrl"), cfg.optString("deviceToken")) }
                        checking = false
                        if (result?.ok == true) UploadWorker.enqueue(ctx)
                    }
                }) { Text(if (checking) "Checking…" else "Test connection") }
            }
            result?.let {
                Text(
                    (if (it.ok) "✓ " else "") + it.message,
                    color = if (it.ok) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 4.dp),
                )
            }
        }

        }
        Spacer(Modifier.height(24.dp))
    }
}

/**
 * Text setting that owns its text while you type and saves once typing pauses (and when the
 * screen closes). Saving on every keystroke made fast input drop characters.
 */
@Composable
private fun SettingField(
    initial: String,
    label: String,
    keyboard: KeyboardType = KeyboardType.Text,
    secret: Boolean = false,
    save: (String) -> Unit,
) {
    var text by remember { mutableStateOf(initial) }
    var saved by remember { mutableStateOf(initial) }
    val latestText by rememberUpdatedState(text)
    val latestSave by rememberUpdatedState(save)
    LaunchedEffect(text) {
        if (text == saved) return@LaunchedEffect
        delay(400)
        save(text)
        saved = text
    }
    DisposableEffect(Unit) {
        onDispose { if (latestText != saved) latestSave(latestText) }
    }
    OutlinedTextField(
        text, { text = it }, Modifier.fillMaxWidth(),
        label = { Text(label) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = keyboard),
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
    )
}

@Composable
private fun DeviceList(
    btOk: Boolean,
    devices: List<Pair<String, String>>,
    selected: String,
    noneLabel: String?,
    onSelect: (name: String, address: String) -> Unit,
) {
    if (!btOk) {
        Muted("Grant the nearby devices permission (main screen) to see paired devices.")
        return
    }
    if (devices.isEmpty()) Muted("No paired devices.")
    if (noneLabel != null) RadioRow(selected.isBlank(), noneLabel, null) { onSelect("", "") }
    devices.forEach { (name, addr) ->
        RadioRow(addr.equals(selected, ignoreCase = true), name, addr) { onSelect(name, addr) }
    }
}

@Composable
private fun FeedbackSwitch(title: String, detail: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Muted(detail)
        }
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun AdvancedSection(cfg: JSONObject, open: Boolean, setOpen: (Boolean) -> Unit, save: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var info by remember { mutableStateOf("") }
    Section {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Advanced", style = MaterialTheme.typography.titleMedium)
                Muted("Upload server, sensor rates, OBD signal lists, chunk size, upload rules. You won't need these unless you run the server.")
            }
            TextButton(onClick = {
                setOpen(!open)
                info = ""
                if (open) text = JSONObject(cfg.toString()).apply { put("deviceToken", "") }.toString(2)
                error = ""
            }) { Text(if (open) "Hide" else "Show") }
        }
        if (!open) return@Section
        Muted("Raw settings as JSON. Sensor rates are in Hz (0 = off, -1 = fastest). OBD signal lists are hex PIDs. The device token is hidden here and kept unless you type a new one.")
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            text, { text = it; error = "" }, Modifier.fillMaxWidth(),
            textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
        )
        if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
        if (info.isNotEmpty()) Muted(info)
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = {
                try {
                    val j = JSONObject(text)
                    if (j.optString("deviceToken").isBlank()) j.put("deviceToken", cfg.optString("deviceToken"))
                    save(j.toString())
                    error = ""
                    setOpen(false)
                } catch (e: IllegalArgumentException) {
                    error = "Not saved: ${e.message}"
                } catch (e: Exception) {
                    error = "Not valid JSON: ${e.message}"
                }
            }) { Text("Save") }
            OutlinedButton(onClick = {
                // Keep connection and device choices; reset everything else.
                val keep = listOf("serverUrl", "deviceToken", "vehicle", "vehicleVin")
                val d = JSONObject(Config.DEFAULTS)
                keep.forEach { d.put(it, cfg.opt(it)) }
                d.getJSONObject("obd").put("deviceAddress", cfg.getJSONObject("obd").optString("deviceAddress"))
                    .put("deviceName", cfg.getJSONObject("obd").optString("deviceName"))
                val a = cfg.getJSONObject("auto")
                d.getJSONObject("auto").put("enabled", a.optBoolean("enabled")).put("carAddress", a.optString("carAddress"))
                    .put("carName", a.optString("carName"))
                text = JSONObject(d.toString()).apply { put("deviceToken", "") }.toString(2)
                error = ""
                info = "Defaults loaded. Tap Save to apply."
            }) { Text("Reset to defaults") }
        }
    }
}
