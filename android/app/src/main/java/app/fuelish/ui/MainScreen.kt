package app.fuelish.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
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
import androidx.compose.material3.AlertDialog
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
import app.fuelish.VehicleNaming
import app.fuelish.auto.CarBluetooth
import app.fuelish.obd.AdapterCheck
import app.fuelish.obd.BluetoothSppTransport
import android.bluetooth.BluetoothManager
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import app.fuelish.upload.UploadWorker
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

// Notification permission only exists from Android 13; asking for it earlier is never "granted".
val PERMISSIONS = listOfNotNull(
    Manifest.permission.ACCESS_FINE_LOCATION,
    Manifest.permission.ACCESS_COARSE_LOCATION,
    Manifest.permission.BLUETOOTH_CONNECT,
    if (Build.VERSION.SDK_INT >= 33) Manifest.permission.POST_NOTIFICATIONS else null,
).toTypedArray()

@Composable
fun MainScreen(openSettings: () -> Unit, showTrips: () -> Unit, signIn: (done: (String?) -> Unit) -> Unit) {
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
    val ready = remember(refresh) { Readiness.of(ctx) }
    val missing = ready.missingPermissions
    val batteryOk = ready.battery
    val bgLocationOk = ready.background
    var storage by remember { mutableLongStateOf(0L) }
    LaunchedEffect(refresh) { storage = Prefs.store(ctx).bytesUsed() }

    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { refresh++ }
    var askedBg by remember { mutableStateOf(false) }
    val bgLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { askedBg = true; refresh++ }

    val locationOk = ready.location
    // Has an upload key; [ready.signedIn] also needs the server to still accept it.
    val serverOk = cfg.serverUrl.isNotBlank() && cfg.deviceToken.isNotBlank()
    val auto = cfg.auto
    val autoOn = auto.optBoolean("enabled") && auto.optString("carAddress").isNotBlank()
    val obdChosen = cfg.obd.optString("deviceAddress").isNotBlank()
    var signingIn by remember { mutableStateOf(false) }
    var signInError by remember { mutableStateOf("") }
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

        // Setup is one step at a time: each says why it matters, and the next appears when it's done.
        // The adapter can be skipped (phone sensors alone make a trip); with one, the first drive names
        // the vehicle from the VIN, so only someone without an adapter types it.
        val skippedAdapter = remember(refresh) { Prefs.skippedAdapter(ctx) }
        val suggestion = remember(refresh) { Prefs.autoSuggestion(ctx) }
        var pairProblem by remember { mutableStateOf("") }
        val pair = rememberAdapterPairing { _, problem ->
            pairProblem = problem
            refresh++
        }
        var askedPerms by remember { mutableStateOf(false) }
        val carName = auto.optString("carName")
        fun save(change: org.json.JSONObject.() -> Unit) {
            runCatching { Prefs.saveConfig(ctx, org.json.JSONObject(Prefs.config(ctx).json.toString()).apply(change).toString()) }
            refresh++
        }
        val scope = rememberCoroutineScope()
        var testing by remember { mutableStateOf(false) }
        var test by remember { mutableStateOf<AdapterCheck.Result?>(null) }
        val obdAddr = cfg.obd.optString("deviceAddress")
        fun runTest() {
            testing = true
            test = null
            scope.launch {
                val r = withContext(Dispatchers.IO) {
                    try {
                        BluetoothSppTransport.connect(ctx, obdAddr).use { AdapterCheck.run(it) }
                    } catch (e: Exception) {
                        AdapterCheck.Result(
                            false,
                            problem = "Couldn't connect to ${cfg.obd.optString("deviceName").ifBlank { "the adapter" }}. " +
                                "Check it's plugged in with the car on (press its button if it has one), and that it shows as paired in Bluetooth settings.",
                        )
                    }
                }
                test = r
                testing = false
                if (r.ok) Prefs.setAdapterChecked(ctx, obdAddr)
                // Parked at home on Wi-Fi is a good time to name the car from its VIN.
                if (r.vin.isNotEmpty()) withContext(Dispatchers.IO) { VehicleNaming.lookUp(ctx, r.vin) }
                refresh++
            }
        }
        var pickingCar by remember { mutableStateOf(false) }
        val bonded = remember(refresh, missing) {
            if (Manifest.permission.BLUETOOTH_CONNECT in missing) emptyList()
            else @SuppressLint("MissingPermission") {
                ctx.getSystemService(BluetoothManager::class.java)?.adapter?.bondedDevices
                    ?.filter { !it.address.equals(obdAddr, ignoreCase = true) }
                    ?.sortedWith(compareBy({ !CarBluetooth.looksLikeCar(it) }, { (it.name ?: "").lowercase() }))
                    ?.map { (it.name ?: "Unnamed device") to it.address } ?: emptyList()
            }
        }

        val steps = buildList {
            if (cfg.serverUrl.isBlank()) {
                add(Step(false, "Upload server", "", "Where recordings are sent.", "Set up", openSettings))
            } else {
                add(Step(
                    ready.signedIn, if (ready.signInNeeded) "Sign in again" else "Sign in", Prefs.uploadTarget(ctx).accountName ?: "Signed in",
                    signInError.ifEmpty {
                        if (ready.signInNeeded) "The server stopped accepting this phone's uploads (it was signed out or removed on the Account page). " +
                            "Sign in again to resume. Recordings on this phone are kept and upload afterward."
                        else "Use the Google account you were invited with. Your drives upload as yours and show up on the Trips page."
                    },
                    if (signingIn) null else "Sign in with Google",
                    {
                        signingIn = true
                        signInError = ""
                        signIn { err ->
                            signingIn = false
                            signInError = err.orEmpty()
                            refresh++
                        }
                    },
                ))
            }
            add(Step(
                missing.isEmpty(), "Permissions", "Location, nearby devices and notifications",
                "Location maps each drive. Nearby devices lets Fuelish talk to the OBD adapter. Notifications show while a drive is recording." +
                    if (askedPerms && missing.isNotEmpty()) " Still needed: ${missing.map(::permissionLabel).distinct().joinToString(", ")}." else "",
                "Allow", { askedPerms = true; permLauncher.launch(PERMISSIONS) },
                extra = if (askedPerms && missing.isNotEmpty()) {
                    {
                        TextButton(onClick = {
                            ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.packageName)))
                        }) { Text("Android stopped asking? Open Fuelish's settings") }
                    }
                } else null,
            ))
            if (!obdChosen) {
                add(Step(
                    skippedAdapter, "OBD adapter", "None: phone sensors only",
                    pairProblem.ifEmpty {
                        "Plug the adapter into the port under the steering wheel, turn the car on, and press the adapter's button. " +
                            "It reads the engine, for real fuel numbers."
                    },
                    "Find adapter", { pairProblem = ""; pair() },
                    skip = "I don't have one" to { Prefs.setSkippedAdapter(ctx, true); refresh++ },
                ))
            } else {
                // Choosing it isn't proof it works: a parked test confirms the adapter and the car answer.
                val name = cfg.obd.optString("deviceName").ifBlank { "the adapter" }
                val tested = Prefs.adapterChecked(ctx).equals(obdAddr, ignoreCase = true)
                add(Step(
                    ready.adapterDone, "OBD adapter", if (tested) "$name · tested" else "$name · not tested yet",
                    "With the car on (engine running is best), test $name: Fuelish checks that the adapter and the car answer and which fuel readings the car gives.",
                    if (testing) null else if (test == null) "Test connection" else "Test again", ::runTest,
                    skip = if (testing) null else "Test on my first drive" to { Prefs.setAdapterTestSkipped(ctx, obdAddr); refresh++ },
                    extra = {
                        if (testing) Muted("Testing… this takes up to 20 seconds.", Modifier.padding(top = 8.dp))
                        test?.let { AdapterResult(it) }
                        if (!testing && test?.ok != true) {
                            TextButton(onClick = { pairProblem = ""; test = null; pair() }) { Text("Choose a different adapter") }
                            if (pairProblem.isNotEmpty()) Muted(pairProblem)
                        }
                    },
                ))
            }
            add(Step(
                batteryOk, "Battery", "Unrestricted",
                "So Android doesn't stop a recording or an upload while the screen is off.",
                "Allow",
                {
                    @SuppressLint("BatteryLife")
                    val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.packageName))
                    ctx.startActivity(i)
                },
            ))
            if (!obdChosen) {
                add(Step(
                    cfg.vehicle.isNotBlank(), "Vehicle", cfg.vehicle,
                    "Year, make and model. It sets the weight and the fuel rating your drives are compared with.",
                    null, {},
                    extra = {
                        var typed by remember { mutableStateOf("") }
                        OutlinedTextField(
                            typed, { typed = it }, Modifier.fillMaxWidth().padding(top = 8.dp), singleLine = true,
                            label = { Text("Like \"2019 Ram 1500\"") },
                        )
                        Button(onClick = { save { put("vehicle", typed.trim()).put("vehicleVin", "") } }, enabled = typed.isNotBlank()) { Text("Save") }
                    },
                ))
            }
            add(Step(
                ready.modeChosen, "How recording starts",
                if (autoOn) "By itself, when the phone connects to $carName" else "You tap Start and Stop",
                if (!pickingCar) "Fuelish can start recording by itself when your phone connects to the car's Bluetooth (for music or calls), and stop after you park. " +
                    "Or you can start and stop each drive yourself."
                else "Which one is your car? Pick what your phone connects to in the car.",
                if (pickingCar) null else "Automatically", { pickingCar = true },
                skip = if (pickingCar) "Back" to { pickingCar = false } else "I'll start and stop it myself" to { Prefs.setRecordMode(ctx, "manual"); refresh++ },
                extra = if (!pickingCar) null else {
                    {
                        bonded.forEach { (name, addr) ->
                            RadioRow(false, name, null) {
                                save { getJSONObject("auto").put("enabled", true).put("carAddress", addr).put("carName", name) }
                                Prefs.setRecordMode(ctx, "auto")
                                pickingCar = false
                            }
                        }
                        Muted(if (bonded.isEmpty()) "Your phone isn't paired with anything yet. " else "Not listed? " +
                            "Pair the phone with the car in Bluetooth settings (the car's screen walks you through it), then come back.")
                        TextButton(onClick = { ctx.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)) }) { Text("Bluetooth settings") }
                    }
                },
            ))
            if (autoOn) {
                add(Step(
                    bgLocationOk, "Location all the time", "Allowed",
                    "Choose \"Allow all the time\" so recording can start by itself when your phone connects to $carName.",
                    "Allow", { bgLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) },
                    // Android stops showing the request after it's been turned down; settings always works.
                    extra = if (askedBg && !bgLocationOk) {
                        {
                            Muted("In Fuelish's settings, tap Permissions › Location › Allow all the time.", Modifier.padding(top = 8.dp))
                            TextButton(onClick = {
                                ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + ctx.packageName)))
                            }) { Text("Open Fuelish's settings") }
                        }
                    } else null,
                ))
            }
        }
        val current = steps.indexOfFirst { !it.done }
        val setupDone = current < 0
        // While setup is unfinished it comes first; afterwards it disappears.
        if (setupDone || st.recording) {
            if (st.recording) RecordingCard(st) else IdleCard(locationOk, autoOn, carName, st.stopping, openSettings)
        }
        if (!setupDone) {
            Section("Set up Fuelish") {
                Muted("Step ${current + 1} of ${steps.size}")
                steps.forEachIndexed { i, step ->
                    when {
                        step.done -> SetupRow(true, step.title, step.summary, null) {}
                        i == current -> CurrentStep(step)
                        else -> SetupRow(false, step.title, "", null) {}
                    }
                }
            }
        }
        // After a drive with the car's Bluetooth connected: one tap to record every drive by itself.
        if (suggestion != null && !autoOn && !st.recording) {
            Section("Record every drive automatically?") {
                Text(
                    "Your phone was connected to ${suggestion.first} on that drive. Fuelish can start recording whenever it connects, and stop after you park.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Button(onClick = {
                        save { getJSONObject("auto").put("enabled", true).put("carAddress", suggestion.second).put("carName", suggestion.first) }
                        Prefs.answerAutoSuggestion(ctx, true)
                        Prefs.setRecordMode(ctx, "auto")
                        if (!bgLocationOk) bgLauncher.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                    }) { Text("Yes, record automatically") }
                    TextButton(onClick = { Prefs.answerAutoSuggestion(ctx, false); refresh++ }) { Text("No thanks") }
                }
            }
        }

        if (!setupDone && !st.recording) IdleCard(locationOk, autoOn, carName, st.stopping, openSettings)
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
                    ready.signInNeeded -> "$what will upload after you sign in again"
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
            if (serverOk) {
                val target = remember(refresh) { Prefs.uploadTarget(ctx) }
                Muted("Uploads as ${target.accountName ?: "this phone's signed-in account"}. Signing out of the Trips page doesn't change that; signing in as someone else does.")
            }
            if (up.held.isNotEmpty()) HeldTrips(up.held) { refresh++ }
            if (up.lastResult.isNotEmpty()) {
                Muted("Last upload: " + up.lastResult + " (" + DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(up.lastAtMs)) + ")")
            }
            Muted("On this phone: ${mb(storage)}." + if (cfg.upload.optBoolean("deleteAfterUpload", true)) " Deleted once the server confirms it has everything." else " Kept after upload (keep-local-copy is on).")
            if (waiting && ready.signedIn && uploadsOn) {
                Spacer(Modifier.height(4.dp))
                OutlinedButton(onClick = { UploadWorker.enqueue(ctx, cellular = true) }) {
                    Text(if (onWifi) "Upload now" else "Upload now over mobile data")
                }
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

/**
 * Trips recorded under another account (or for another server), or refused by the server as
 * someone else's. They wait rather than upload as whoever is signed in now; the person can choose
 * to send them as the current account.
 */
@Composable
private fun HeldTrips(ids: List<String>, changed: () -> Unit) {
    val ctx = LocalContext.current
    val store = remember { Prefs.store(ctx) }
    val now = remember(ids) { Prefs.uploadTarget(ctx) }
    var asking by remember { mutableStateOf(false) }
    val reasons = remember(ids) {
        ids.mapNotNull { id ->
            if (!store.dir(id).exists()) return@mapNotNull null
            val t = store.target(id)
            store.refusal(id, now.key)?.let { return@mapNotNull "the server refused it ($it)" }
            when {
                t == null -> null
                t.server != now.server -> "recorded for ${t.server.removePrefix("https://")}"
                else -> "recorded while signed in as ${t.accountName ?: "another account"}"
            }
        }.groupingBy { it }.eachCount()
    }
    val n = ids.size
    Text(
        "$n trip${if (n == 1) " is" else "s are"} waiting: " + reasons.entries.joinToString("; ") { (why, k) -> if (reasons.size == 1) why else "$k $why" } +
            ". They upload when that account is signed in on this phone.",
        style = MaterialTheme.typography.bodyMedium,
    )
    TextButton(onClick = { asking = true }) { Text("Upload them as ${now.accountName ?: "this account"}") }
    if (asking) {
        AlertDialog(
            onDismissRequest = { asking = false },
            title = { Text("Upload as ${now.accountName ?: "this account"}?") },
            text = {
                Text(
                    "These trips will count as ${now.accountName ?: "this account"}'s. The server still refuses any that already belong to someone else; " +
                        "the server's owner can move a phone's trips to the right person on the Account page.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    asking = false
                    ids.filter { store.dir(it).exists() }.forEach { store.retarget(it, now) }
                    RecorderState.upload.value = RecorderState.upload.value.copy(held = emptyList())
                    UploadWorker.enqueue(ctx)
                    changed()
                }) { Text("Upload") }
            },
            dismissButton = { TextButton(onClick = { asking = false }) { Text("Not now") } },
        )
    }
}

@Composable
private fun IdleCard(locationOk: Boolean, autoOn: Boolean, carName: String, stopping: Boolean, openSettings: () -> Unit) {
    val ctx = LocalContext.current
    var note by remember { mutableStateOf("") }
    Section {
        Text(if (stopping) "Saving recording…" else "Not recording", style = MaterialTheme.typography.titleLarge)
        Muted(
            when {
                !locationOk -> "Grant permissions above to start recording."
                autoOn -> "The next recording starts by itself when your phone connects to $carName, and stops shortly after you park."
                else -> "Tap Start recording when you set off, and Stop recording when you get there. Or let Fuelish start by itself whenever you get in the car."
            },
        )
        if (locationOk && !autoOn) TextButton(onClick = openSettings) { Text("Set up auto-record") }
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

/** One first-run setup step. [why] shows while it's the step to do; [summary] once it's done. */
private class Step(
    val done: Boolean,
    val title: String,
    val summary: String,
    val why: String,
    val action: String?,
    val run: () -> Unit,
    val skip: Pair<String, () -> Unit>? = null,
    val extra: (@Composable () -> Unit)? = null,
)

@Composable
private fun CurrentStep(s: Step) {
    Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
        Text(s.title, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(4.dp))
        Text(s.why, style = MaterialTheme.typography.bodyMedium)
        s.extra?.invoke()
        if (s.action != null || s.skip != null) {
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (s.action != null) Button(onClick = s.run) { Text(s.action) }
                s.skip?.let { (label, run) -> TextButton(onClick = run) { Text(label) } }
            }
        }
    }
}

/** What the adapter test found, one line per check, in plain words. */
@Composable
private fun AdapterResult(r: AdapterCheck.Result) {
    val bad = MaterialTheme.colorScheme.error
    val good = MaterialTheme.colorScheme.primary
    @Composable
    fun check(ok: Boolean?, text: String) {
        Text(
            (if (ok == true) "✓  " else if (ok == false) "✗  " else "–  ") + text,
            color = if (ok == false) bad else if (ok == true) good else Color.Unspecified,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
    Column(Modifier.padding(top = 8.dp)) {
        check(r.adapterOk, if (r.adapterOk) "Adapter connected" + (if (r.adapterName.isNotBlank()) " (${r.adapterName})" else "") else "Adapter didn't connect")
        if (r.adapterOk) check(r.carOk, if (r.carOk) "Car is answering" else "Car isn't answering")
        if (r.carOk) {
            check(r.vin.isNotEmpty().takeIf { it }, if (r.vin.isNotEmpty()) "Vehicle identified (VIN ${r.vin})" else "The car didn't give its VIN; type the vehicle in Settings")
            check(
                r.fuel != AdapterCheck.Fuel.NONE,
                when (r.fuel) {
                    AdapterCheck.Fuel.REPORTED -> "Fuel use: the car reports it"
                    AdapterCheck.Fuel.AIRFLOW -> "Fuel use: worked out from the airflow sensor"
                    else -> "This car doesn't give the readings fuel use is worked out from. Trips still get route, time and cost of time, but no gallons or mpg."
                },
            )
        }
        if (r.problem.isNotEmpty()) Text(r.problem, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 4.dp))
        if (r.ok) Muted("All set.")
    }
}
