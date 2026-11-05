package app.fuelish.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import app.fuelish.Prefs
import app.fuelish.RecorderService
import app.fuelish.RecorderState
import kotlinx.coroutines.delay

/**
 * One app: the trips (the web page, in a WebView) fill the screen, with a strip along the bottom
 * showing what the recorder is doing. Tapping the strip opens the recorder (start/stop, setup,
 * uploads, settings) over the trips; back returns to them.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: TripsWeb
    private var recorderOpen by mutableStateOf(false)
    private var settingsOpen by mutableStateOf(false)
    /** A page the web view should go to once it's on screen (from a notification). */
    private var pendingHash by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = TripsWeb(this) { invite, legacy -> signIn(invite, legacy) }
        // Until the server is set and location is granted, the recorder's setup is what matters.
        recorderOpen = savedInstanceState?.getBoolean("recorderOpen")
            ?: (Prefs.config(this).serverUrl.isBlank() || checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
        settingsOpen = savedInstanceState?.getBoolean("settingsOpen") ?: false
        handleIntent(intent)
        enableEdgeToEdge()
        setContent {
            val ctx = LocalContext.current
            // Material You: follow the phone's wallpaper colors.
            val colors = if (isSystemInDarkTheme()) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
            MaterialTheme(colorScheme = colors) {
                Surface(Modifier.fillMaxSize()) {
                    Box(Modifier.fillMaxSize()) {
                        TripsPane()
                        if (recorderOpen) {
                            Surface(Modifier.fillMaxSize()) {
                                BackHandler(!settingsOpen) { recorderOpen = false }
                                BackHandler(settingsOpen) { settingsOpen = false }
                                if (settingsOpen) SettingsScreen { settingsOpen = false }
                                else MainScreen(openSettings = { settingsOpen = true }, showTrips = { recorderOpen = false })
                            }
                        }
                    }
                }
            }
        }
    }

    @Composable
    private fun TripsPane() {
        val ctx = LocalContext.current
        var server by remember { mutableStateOf(Prefs.config(ctx).serverUrl) }
        LifecycleResumeEffect(Unit) {
            server = Prefs.config(ctx).serverUrl
            // Back from elsewhere: the trip list may have new trips. Other pages stay as they were.
            web.view.evaluateJavascript("""if (location.hash === "" || location.hash === "#/") window.dispatchEvent(new HashChangeEvent("hashchange"))""", null)
            onPauseOrDispose { }
        }
        // Settings can change the server while the recorder is open over this pane.
        LaunchedEffect(recorderOpen) { server = Prefs.config(ctx).serverUrl }
        LaunchedEffect(server, pendingHash) {
            web.show(server, pendingHash)
            pendingHash = null
        }
        BackHandler(!recorderOpen) { if (!web.back()) moveTaskToBack(true) }
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)).imePadding()) {
                if (server.isBlank()) NoServer { recorderOpen = true; settingsOpen = true }
                else {
                    AndroidView({ web.view }, Modifier.fillMaxSize())
                    if (web.loadFailed) Offline(web::retry)
                }
            }
            HorizontalDivider()
            RecorderStrip(refreshKey = recorderOpen) { recorderOpen = true }
        }
    }

    private fun signIn(invite: String, legacyToken: String) {
        val server = Prefs.config(this).serverUrl
        lifecycleScope.launch {
            when (val r = GoogleSignIn.signIn(this@MainActivity, server, invite, legacyToken)) {
                GoogleSignIn.Result.Ok -> web.signInDone(true)
                GoogleSignIn.Result.Cancelled -> web.signInDone(false)
                is GoogleSignIn.Result.Failed -> web.signInDone(false, r.message)
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean("recorderOpen", recorderOpen)
        outState.putBoolean("settingsOpen", settingsOpen)
    }

    override fun onDestroy() {
        web.view.destroy()
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(i: Intent?) {
        i ?: return
        i.getStringExtra(EXTRA_OPEN_PAGE)?.let { hash ->
            i.removeExtra(EXTRA_OPEN_PAGE)
            pendingHash = hash
            recorderOpen = false
            settingsOpen = false
        }
        // Tapping the "Car connected: tap to record" notification lands here; we're in the foreground now.
        val trigger = i.getStringExtra(EXTRA_START_TRIGGER) ?: return
        i.removeExtra(EXTRA_START_TRIGGER)
        recorderOpen = true
        if (RecorderService.activeId == null && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            RecorderService.start(this, "", trigger)
        }
    }

    companion object {
        const val EXTRA_START_TRIGGER = "startTrigger"
        /** A web page hash to open, e.g. "#/r/<recording id>". */
        const val EXTRA_OPEN_PAGE = "openPage"
    }
}

@Composable
private fun NoServer(setUp: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("Your trips show up here", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        Muted("Set the server URL first. Recordings upload there and the trips page comes from it.")
        Spacer(Modifier.height(16.dp))
        Button(onClick = setUp) { Text("Set up the server") }
    }
}

@Composable
private fun Offline(retry: () -> Unit) {
    Surface(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Can't reach your trips", style = MaterialTheme.typography.titleLarge)
            Spacer(Modifier.height(8.dp))
            Muted("No connection to the server right now. Recording works without it; trips upload later.")
            Spacer(Modifier.height(16.dp))
            Button(onClick = retry) { Text("Try again") }
        }
    }
}

/** One line along the bottom: what the recorder is doing right now. Tap it to open the recorder. */
@Composable
private fun RecorderStrip(refreshKey: Any, open: () -> Unit) {
    val ctx = LocalContext.current
    val st by RecorderState.status.collectAsStateWithLifecycle()
    val up by RecorderState.upload.collectAsStateWithLifecycle()
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtimeNanos()) }
    LaunchedEffect(st.recording) {
        while (st.recording) {
            now = SystemClock.elapsedRealtimeNanos()
            delay(1000)
        }
    }
    // Settings change on the recorder screen (auto-record, car): re-read on the way back, and on resume.
    var resumed by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        resumed++
        onPauseOrDispose { }
    }
    val cfg = remember(st.recording, st.stopping, refreshKey, resumed) { Prefs.config(ctx) }
    val locationOk = ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    val auto = cfg.auto
    val autoOn = auto.optBoolean("enabled") && auto.optString("carAddress").isNotBlank()
    val err = MaterialTheme.colorScheme.error

    val (dot, title) = when {
        st.recording && st.stopping -> null to "Saving recording…"
        st.recording -> err to "Recording " + elapsed((now - st.startedElapsedNs) / 1_000_000_000)
        st.stopping -> null to "Saving recording…"
        !locationOk -> err to "Recorder needs setup"
        else -> null to "Not recording"
    }
    val detail = when {
        st.recording -> st.problems.firstOrNull() ?: if (st.trigger != RecorderService.TRIGGER_MANUAL) "stops on its own after you park" else "tap to stop"
        up.running -> "uploading…"
        up.pending > 0 -> "${up.pending} part${if (up.pending == 1) "" else "s"} to upload"
        !locationOk -> "tap to finish"
        autoOn -> "starts with ${auto.optString("carName")}"
        else -> "tap to start"
    }

    Surface(color = MaterialTheme.colorScheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Row(
            Modifier.clickable(onClick = open).navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (dot != null) Text("●  ", color = dot)
            Text(title, style = MaterialTheme.typography.titleSmall.copy(fontFeatureSettings = "tnum"))
            Text(
                "  ·  $detail", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Text("Recorder ›", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        }
    }
}
