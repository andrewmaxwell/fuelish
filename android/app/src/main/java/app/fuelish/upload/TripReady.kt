package app.fuelish.upload

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import app.fuelish.R
import app.fuelish.ui.MainActivity
import org.json.JSONObject
import java.text.DateFormat
import java.util.Date

/** "Your trip is ready": posted once the server has all of a trip; tapping it opens that trip. */
object TripReady {
    private const val CHANNEL = "trips"

    fun createChannel(c: Context) {
        c.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Trip ready", NotificationManager.IMPORTANCE_LOW),
        )
    }

    fun notify(c: Context, id: String, meta: JSONObject) {
        // Recordings that never got going (a few seconds in the driveway) aren't worth a notification.
        val start = meta.optLong("startedWallMs")
        val end = meta.optLong("driveEndWallMs").takeIf { it > 0 } ?: meta.optLong("endedWallMs")
        if (start <= 0 || end - start < 60_000) return
        val open = PendingIntent.getActivity(
            c, id.hashCode(),
            Intent(c, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_PAGE, "#/r/$id")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val time = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(start))
        val minutes = (end - start) / 60_000
        val n = Notification.Builder(c, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Trip ready")
            .setContentText("Your $time drive ($minutes min) is uploaded. Tap to see it.")
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        c.getSystemService(NotificationManager::class.java).notify(id, 1, n)
    }
}
