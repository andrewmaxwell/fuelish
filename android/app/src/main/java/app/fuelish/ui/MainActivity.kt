package app.fuelish.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import app.fuelish.RecorderService

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleStartTrigger(intent)
        enableEdgeToEdge()
        setContent {
            val ctx = LocalContext.current
            // Material You: follow the phone's wallpaper colors.
            val colors = if (isSystemInDarkTheme()) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
            MaterialTheme(colorScheme = colors) {
                Surface(Modifier.fillMaxSize()) {
                    var settings by rememberSaveable { mutableStateOf(false) }
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
