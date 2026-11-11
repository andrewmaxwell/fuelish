package app.fuelish

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import androidx.core.app.ServiceCompat
import app.fuelish.auto.AutoStopPolicy
import app.fuelish.auto.CarBluetooth
import app.fuelish.auto.DriveDetect
import app.fuelish.feedback.DriveTally
import app.fuelish.feedback.DriveVoice
import app.fuelish.feedback.DriveWatch
import app.fuelish.feedback.GasPrice
import app.fuelish.feedback.SummaryTiming
import app.fuelish.obd.BluetoothSppTransport
import app.fuelish.obd.ObdRecorder
import app.fuelish.record.JsonLine
import app.fuelish.record.RecordingStore
import app.fuelish.record.RecordingWriter
import app.fuelish.sensors.PhoneSensors
import app.fuelish.sensors.PowerMonitor
import app.fuelish.ui.MainActivity
import app.fuelish.upload.UploadWorker
import org.json.JSONArray
import org.json.JSONObject
import java.util.TimeZone
import java.util.concurrent.Executors

/**
 * Foreground service that owns one recording at a time. Keeps a partial wake lock so
 * sensors, GPS and OBD keep flowing with the screen off.
 */
class RecorderService : Service() {
    private val control = Executors.newSingleThreadExecutor()
    private var session: Session? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                startForegroundNow()
                val note = intent.getStringExtra(EXTRA_NOTE).orEmpty()
                val trigger = intent.getStringExtra(EXTRA_TRIGGER) ?: TRIGGER_MANUAL
                val resumes = intent.getStringExtra(EXTRA_RESUMES)
                control.execute { if (session == null) session = Session(note, trigger, resumes).also { it.start() } }
            }
            ACTION_STOP -> control.execute { stopSession("manual") }
            ACTION_CAR_CONNECTED, ACTION_CAR_DISCONNECTED -> control.execute {
                session?.carEvent(intent.action == ACTION_CAR_CONNECTED) ?: stopSelf()
            }
            ACTION_LEFT_VEHICLE -> control.execute { session?.leftVehicle() ?: stopSelf() }
            else -> control.execute { if (session == null) stopSelf() }
        }
        // If the process is killed the recording is finished as "interrupted" on next launch;
        // we don't auto-restart because background FGS starts can't use location. (An app update
        // is the exception: AppUpdatedReceiver carries the drive on in a new recording.)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        // System teardown while recording: flush what we can synchronously.
        session?.let { runCatching { it.stop("service_destroyed") } }
        session = null
        control.shutdown()
        super.onDestroy()
    }

    private fun stopSession(reason: String) {
        session?.stop(reason)
        session = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun startForegroundNow() {
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        val cfg = Prefs.config(this)
        if (cfg.obd.optBoolean("enabled") && hasPerm(Manifest.permission.BLUETOOTH_CONNECT)) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification("Starting…"), types)
    }

    private fun hasPerm(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(
            this, 1, Intent(this, RecorderService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Fuelish recording")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    /** Everything that lives for exactly one recording. */
    private inner class Session(private val note: String, private val trigger: String, private val resumes: String? = null) {
        private val ctx = this@RecorderService
        private val cfg = Prefs.config(ctx)
        private val store = Prefs.store(ctx)
        private val id = RecordingStore.newId(System.currentTimeMillis())
        private val startedWall = System.currentTimeMillis()
        private val startedNs = SystemClock.elapsedRealtimeNanos()
        private val meta = JSONObject()
        private val wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fuelish:recording")
        private val sensorThread = HandlerThread("fuelish-sensors", Process.THREAD_PRIORITY_MORE_FAVORABLE)
        private val tickThread = HandlerThread("fuelish-tick")
        private lateinit var tick: Handler
        private lateinit var writer: RecordingWriter
        private lateinit var sensors: PhoneSensors
        private lateinit var power: PowerMonitor
        private var obd: ObdRecorder? = null
        private val problems = mutableListOf<String>()
        private var lastCounts = emptyMap<String, Long>()
        private var vinSeen = false
        private var adapterProven = false
        @Volatile private var ended = false
        /** Started by Android detecting a drive: kept only if the engine answers through the adapter. */
        private val detected = trigger == DriveDetect.TRIGGER
        /** Only recordings that started automatically also stop automatically. */
        private val autoStop = if (trigger == TRIGGER_MANUAL) null else AutoStopPolicy(
            cfg.auto.optLong("stopAfterCarDisconnectS", 10) * 1_000_000_000,
            cfg.auto.optLong("stopAfterEngineOffS", 60) * 1_000_000_000,
            if (detected) cfg.auto.optLong("adapterWaitS", 120) * 1_000_000_000 else 0,
        )
        private val sounds = cfg.feedback.optBoolean("sounds", true)
        private val spokenSummary = cfg.feedback.optBoolean("summary", true)
        private val warnings = cfg.feedback.optBoolean("warnings", true)
        private val tips = cfg.feedback.optBoolean("tips", true)
        private val summaryTiming = SummaryTiming()
        private var carConnected = true
        private var keptSaid = false
        // A detected drive in a car without the adapter is thrown away, so it never warns about the adapter.
        private val watch = DriveWatch(
            expectAdapter = !detected && cfg.obd.optBoolean("enabled") && cfg.obd.optString("deviceAddress").isNotBlank(),
            milWasOn = Prefs.milOn(ctx),
        )
        private val tally = DriveTally()
        private var lastGpsNs = 0L
        private var lastTickNs = 0L
        @Volatile private var stopRequested = false
        private var ticks = 0L

        fun start() {
            wakeLock.acquire()
            RecorderService.activeId = id
            meta.put("id", id).put("formatVersion", RecordingWriter.FORMAT_VERSION)
                .put("deviceId", Prefs.deviceId(ctx)).put("status", "recording")
                .put("startedWallMs", startedWall).put("startedElapsedNs", startedNs)
                .put("timezone", TimeZone.getDefault().id)
                .put("vehicle", cfg.vehicle).put("note", note).put("trigger", trigger)
                .put("app", appInfo()).put("device", deviceInfo())
                .put("config", cfg.redacted())
            if (resumes != null) meta.put("resumes", resumes)
            // Its uploads wait until the engine answers through the adapter (see DriveDetect).
            if (detected) meta.put("awaitingAdapter", true)
            store.writeMeta(id, meta)
            // Uploads as whoever is signed in now, even if someone else signs in before it's sent.
            store.setTarget(id, Prefs.uploadTarget(ctx))

            writer = RecordingWriter(
                store.dir(id), id, cfg.chunkSeconds, cfg.chunkMaxBytes,
                elapsedNs = SystemClock::elapsedRealtimeNanos, wallMs = System::currentTimeMillis,
                onChunkClosed = { onChunkClosed() },
            )
            writer.start()
            writer.emit(
                "session", startedNs,
                JsonLine("session", 4096).n("rx", startedNs).n("wall", startedWall).raw("meta", meta.toString()).build(),
            )
            clockRecord()

            sensorThread.start()
            sensors = PhoneSensors(ctx, cfg, writer, Handler(sensorThread.looper))
            if (hasPerm(Manifest.permission.ACCESS_FINE_LOCATION)) sensors.start() else problems += "location permission missing"
            power = PowerMonitor(ctx, writer)
            power.sample()

            startObd()
            runCatching { CarBluetooth.noticeCar(ctx) }

            tickThread.start()
            tick = Handler(tickThread.looper)
            tick.post(::onTick)
            event("start", trigger)

            if (sounds || spokenSummary || warnings || tips) DriveVoice.open(ctx)
            // A detected drive chimes once the adapter proves it's this car (see onTick).
            if (sounds && !detected) DriveVoice.chime(ctx)
            if (spokenSummary) Thread({ GasPrice.refresh(ctx) }, "fuelish-gas").apply { isDaemon = true }.start()
        }

        private fun startObd() {
            val o = cfg.obd
            val reason = when {
                !o.optBoolean("enabled") -> "disabled in config"
                !hasPerm(Manifest.permission.BLUETOOTH_CONNECT) -> "Bluetooth permission missing"
                o.optString("deviceAddress").isBlank() -> "no adapter selected"
                else -> null
            }
            if (reason != null) {
                event("obd_not_started", reason)
                RecorderState.status.value = RecorderState.status.value.copy(obd = app.fuelish.obd.ObdStatus(state = "off", detail = reason))
                return
            }
            obd = ObdRecorder(o, { BluetoothSppTransport.connect(ctx, o.getString("deviceAddress")) }, writer, SystemClock::elapsedRealtimeNanos)
                .also { it.start() }
        }

        private fun event(ev: String, detail: String = "") {
            val now = SystemClock.elapsedRealtimeNanos()
            writer.emit("event", now, JsonLine("event").n("rx", now).s("ev", ev).s("detail", detail).build())
        }

        private fun clockRecord() {
            val now = SystemClock.elapsedRealtimeNanos()
            writer.emit(
                "clock", now,
                JsonLine("clock").n("rx", now).n("wall", System.currentTimeMillis()).n("uptimeMs", SystemClock.uptimeMillis())
                    .n("utcOffsetMin", TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000).build(),
            )
        }

        fun leftVehicle() {
            event("left_vehicle")
            autoStop?.leftVehicle(SystemClock.elapsedRealtimeNanos())
        }

        fun carEvent(connected: Boolean) {
            event(if (connected) "car_bt_connected" else "car_bt_disconnected")
            carConnected = connected
            autoStop?.carEvent(connected, SystemClock.elapsedRealtimeNanos())
        }

        private fun onTick() {
            ticks++
            // A detected drive the engine hasn't confirmed yet: a paired car stereo says it's your car too.
            if (detected && !adapterProven && ticks % 10 == 1L && CarBluetooth.onPairedCar(ctx)) autoStop?.onPairedCar()
            val reason = autoStop?.check(SystemClock.elapsedRealtimeNanos(), obd?.status?.state ?: "off")
            if (detected && !adapterProven && !keptSaid && autoStop?.keptWithoutEngine == true) keepWithoutEngine()
            if (reason != null && !stopRequested) {
                stopRequested = true
                control.execute { if (session === this) stopSession(reason) }
            }
            if (ticks % cfg.batteryIntervalS.coerceAtLeast(1) == 0L) power.sample()
            if (ticks % 10 == 0L) {
                clockRecord()
                val now = SystemClock.elapsedRealtimeNanos()
                writer.emit(
                    "stats", now,
                    JsonLine("stats").n("rx", now).n("written", writer.written.get()).n("dropped", writer.dropped.get())
                        .n("queue", writer.queueSize).n("chunks", writer.chunksClosed).n("gzBytes", writer.gzBytesTotal.get()).build(),
                )
            }
            val counts = sensors.counts.mapValues { it.value.get() }
            val rates = counts.mapValues { (k, v) -> (v - (lastCounts[k] ?: 0L)).toDouble() }
            lastCounts = counts
            val gps = sensors.lastGps
            val gpsText = if (gps == null) "no fix yet" else {
                val age = (SystemClock.elapsedRealtimeNanos() - gps.elapsedRealtimeNanos) / 1e9
                "±%.0f m · %.1f km/h · %d/%d sats · %.0fs ago".format(gps.accuracy, gps.speed * 3.6, sensors.satellitesUsed, sensors.satellitesVisible, age)
            }
            val b = power.last
            RecorderState.status.value = RecorderState.status.value.copy(
                recording = true, recordingId = id, startedElapsedNs = startedNs, trigger = trigger,
                records = writer.written.get(), drops = writer.dropped.get(), queue = writer.queueSize,
                chunks = writer.chunksClosed, gzBytes = writer.gzBytesTotal.get(), rawBytes = writer.rawBytesTotal.get(),
                sensorRates = rates, gps = gpsText,
                obd = obd?.status ?: RecorderState.status.value.obd,
                battery = if (b == null) "" else "%d%% · %s · %.1f°C · %d mA".format(b.pct, if (b.plugged != 0) "plugged" else "on battery", b.tempC, b.currentUa / 1000),
                problems = problems + sensors.problems,
                writerError = writer.error?.toString().orEmpty(),
                miles = tally.miles, gallons = tally.gallons,
            )
            if (ticks % 5 == 0L) {
                val minutes = (SystemClock.elapsedRealtimeNanos() - startedNs) / 60_000_000_000
                val text = listOfNotNull(
                    "$minutes min", DriveTally.soFar(tally.miles, tally.gallons),
                    if (gps == null) "waiting for GPS" else null,
                    // Only worth a word when there's an adapter and it isn't reading the car.
                    obd?.status?.state?.takeIf { it != "polling" && it != "benchmarking" }?.let { "adapter ${it.replace('_', ' ')}" },
                ).joinToString(" · ")
                getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
            }
            // Reading the car on a drive proves the adapter works, as the setup test would.
            if (!adapterProven && obd?.status?.state == "polling") {
                adapterProven = true
                Prefs.config(ctx).obd.optString("deviceAddress").takeIf { it.isNotBlank() }?.let { Prefs.setAdapterChecked(ctx, it) }
                if (detected) {
                    // It's a car with the adapter: keep the recording, and let it upload.
                    synchronized(meta) {
                        meta.remove("awaitingAdapter")
                        store.writeMeta(id, meta)
                    }
                    event("adapter_proven")
                    if (sounds) DriveVoice.chime(ctx)
                    UploadWorker.enqueue(ctx)
                }
            }
            feedback(gps)
            val vin = obd?.status?.vin.orEmpty()
            if (!vinSeen && vin.isNotEmpty()) {
                vinSeen = true
                nameFromVin(vin)
            }
            tick.postDelayed(::onTick, 1000)
        }

        /** Keeps the drive's running totals and says whatever [DriveWatch] finds worth saying. */
        private fun feedback(gps: android.location.Location?) {
            val now = SystemClock.elapsedRealtimeNanos()
            val st = obd?.status
            val state = st?.state ?: "off"
            val numbers = st?.numbers ?: emptyMap()
            if (gps != null && gps.elapsedRealtimeNanos != lastGpsNs) {
                lastGpsNs = gps.elapsedRealtimeNanos
                tally.gps(gps.latitude, gps.longitude, gps.accuracy.toDouble(), gps.speed.toDouble())
            }
            val dtS = if (lastTickNs == 0L) 0.0 else ((now - lastTickNs) / 1e9).coerceAtMost(3.0)
            lastTickNs = now
            if (state == "polling") tally.engine(dtS, numbers)
            val moving = gps != null && gps.speed >= 3f && now - gps.elapsedRealtimeNanos < 5_000_000_000L
            val milBefore = watch.milOn
            for (cue in watch.tick(now, state, numbers, st?.adapterVolts?.let(DriveWatch::parseVolts), moving)) {
                val say = when (cue.kind) {
                    in ADAPTER_CUES -> sounds
                    DriveWatch.Kind.LONG_IDLE -> tips
                    else -> warnings
                }
                event("feedback", "${cue.kind.name.lowercase()}${if (say) "" else " (muted)"}")
                if (say) DriveVoice.say(ctx, DriveWatch.words(cue, GasPrice.forPlace(ctx, tally.startLat, tally.startLon)))
            }
            if (watch.milOn != milBefore) Prefs.setMilOn(ctx, watch.milOn)
            // The summary, while the driver is still in the seat: see SummaryTiming. A recording you stop
            // yourself says it then.
            if (spokenSummary && autoStop != null && summaryTiming.tick(now, state, carConnected, moving, tally.miles)) {
                saySummary(summaryTiming.quietSince ?: now, "early")
            }
        }

        private fun saySummary(driveEndNs: Long, whenSaid: String) {
            val words = DriveTally.summary(tally.miles, (driveEndNs - startedNs) / 60e9, tally.gallons, GasPrice.forPlace(ctx, tally.startLat, tally.startLon)) ?: return
            event("feedback", "summary ($whenSaid)")
            DriveVoice.say(ctx, words)
        }

        /**
         * The adapter wait ran out without the engine answering, but this is the driver's car (see
         * [AutoStopPolicy]): the recording is kept and uploads, from the phone alone, and says so once.
         */
        private fun keepWithoutEngine() {
            keptSaid = true
            synchronized(meta) {
                meta.remove("awaitingAdapter")
                store.writeMeta(id, meta)
            }
            event("kept_without_engine")
            if (sounds) DriveVoice.say(ctx, DriveWatch.words(DriveWatch.Cue(DriveWatch.Kind.ADAPTER_NOT_CONNECTING)))
            UploadWorker.enqueue(ctx)
        }

        /** Names the vehicle from the VIN the adapter just read (see [VehicleNaming]); labels this trip too. */
        private fun nameFromVin(vin: String) {
            Prefs.setLastVin(ctx, vin)
            if (!VehicleNaming.wanted(ctx, vin)) return
            // Another car: until its name is known this trip has none, rather than the last car's.
            synchronized(meta) {
                meta.put("vehicle", "").put("vehicleVin", vin)
                store.writeMeta(id, meta)
            }
            Thread({
                val named = VehicleNaming.lookUp(ctx, vin) ?: return@Thread
                synchronized(meta) {
                    meta.put("vehicle", named)
                    store.writeMeta(id, meta)
                    if (!ended) event("vehicle_named", "$named ($vin)")
                }
            }, "fuelish-vin").apply { isDaemon = true }.start()
        }

        private fun onChunkClosed() {
            synchronized(meta) {
                meta.put("chunksSoFar", writer.chunksClosed)
                store.writeMeta(id, meta)
            }
            UploadWorker.enqueue(ctx)
        }

        fun stop(reason: String) {
            synchronized(meta) { ended = true }
            runCatching { CarBluetooth.noticeCar(ctx) }
            RecorderState.status.value = RecorderState.status.value.copy(stopping = true)
            tick.removeCallbacksAndMessages(null)
            tickThread.quitSafely()
            event("stop", reason)
            sensors.stop()
            obd?.stop()
            power.sample()
            var chunkCount = writer.stop()
            sensorThread.quitSafely()
            if (writer.error != null) {
                // The writer gave up mid-chunk: keep what it wrote, as its own chunk, so it is uploaded
                // and counted instead of sitting unfinished (or being deleted with the recording).
                runCatching { store.finalizeLeftovers(id) }.onFailure { problems += "couldn't finish the last chunk: $it" }
                store.finishedChunks(id).lastOrNull()?.let { chunkCount = maxOf(chunkCount, it + 1) }
            }
            val endedNs = SystemClock.elapsedRealtimeNanos()
            val endedWall = System.currentTimeMillis()
            synchronized(meta) {
                meta.put("status", "stopped").put("stopReason", reason).put("endedWallMs", endedWall)
                    .put("endedElapsedNs", endedNs).put("chunkCount", chunkCount)
                    .put("summary", JSONObject()
                        .put("records", writer.written.get()).put("drops", writer.dropped.get())
                        .put("rawBytes", writer.rawBytesTotal.get()).put("gzBytes", writer.gzBytesTotal.get())
                        .put("battery", power.summary())
                        .put("obd", obd?.summary ?: JSONObject().put("connected", false))
                        .put("problems", JSONArray(problems + sensors.problems))
                        .put("writerError", writer.error?.toString()))
                meta.remove("chunksSoFar")
                // The drive itself ended at the disconnect / engine-off, before the auto-stop wait.
                autoStop?.driveEndNs(reason)?.let { ns ->
                    meta.put("driveEndElapsedNs", ns).put("driveEndWallMs", endedWall - (endedNs - ns) / 1_000_000)
                }
                store.writeMeta(id, meta)
                // Still unnamed (no signal, or the lookup finished for other trips while this one was
                // recording): the upload worker names it once it can.
                val waiting = meta.optString("vehicleVin")
                if (waiting.isNotBlank() && meta.optString("vehicle").isBlank()) Prefs.setPendingVin(ctx, waiting)
            }
            RecorderService.activeId = null
            // A detected drive the adapter never confirmed wasn't in its car (timed out, or ended first, like a
            // short ride in someone else's car): nothing was uploaded, and it goes. Unless you stopped it yourself.
            // Nor does a drive with other signs of being in your own car (the adapter's link came up, or a
            // paired car stereo), once it actually went somewhere.
            val ownCar = autoStop?.ownCarEvidence == true && tally.miles >= 0.3
            val discard = detected && !adapterProven && reason != "manual" && !ownCar
            if (detected && !adapterProven && !discard) synchronized(meta) {
                meta.remove("awaitingAdapter")
                store.writeMeta(id, meta)
            }
            if (discard) {
                store.dir(id).deleteRecursively()
                // Not silently, if the phone did drive somewhere: it may have been your car with the adapter out.
                if (tally.miles >= 0.3) notifyNotKept()
            } else if (spokenSummary && summaryTiming.atStop(tally.miles)) {
                saySummary(autoStop?.driveEndNs(reason) ?: endedNs, "at stop")
            }
            DriveVoice.close()
            if (wakeLock.isHeld) wakeLock.release()
            RecorderState.status.value = RecorderStatus(obd = RecorderState.status.value.obd.copy(state = "off"))
            UploadWorker.enqueue(ctx)
        }

        /** A quiet note that a detected drive wasn't kept, and why; a later one replaces it. */
        private fun notifyNotKept() {
            val why = "The OBD adapter didn't answer, so Fuelish took it for someone else's car. If it was yours, check the adapter is plugged in."
            val open = PendingIntent.getActivity(ctx, 4, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            runCatching {
                getSystemService(NotificationManager::class.java).notify(
                    NOT_KEPT_NOTIFICATION_ID,
                    Notification.Builder(ctx, CHANNEL)
                        .setSmallIcon(R.drawable.ic_notification)
                        .setContentTitle("A drive wasn't kept")
                        .setContentText(why)
                        .setStyle(Notification.BigTextStyle().bigText(why))
                        .setContentIntent(open)
                        .setAutoCancel(true)
                        .build(),
                )
            }
        }

        private fun appInfo(): JSONObject {
            val pi = packageManager.getPackageInfo(packageName, 0)
            return JSONObject().put("versionName", pi.versionName).put("versionCode", pi.longVersionCode)
        }

        private fun deviceInfo() = JSONObject()
            .put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL).put("product", Build.PRODUCT)
            .put("device", Build.DEVICE).put("hardware", Build.HARDWARE).put("socModel", Build.SOC_MODEL)
            .put("sdk", Build.VERSION.SDK_INT).put("release", Build.VERSION.RELEASE).put("fingerprint", Build.FINGERPRINT)
    }

    companion object {
        const val ACTION_START = "app.fuelish.START"
        const val ACTION_STOP = "app.fuelish.STOP"
        const val ACTION_CAR_CONNECTED = "app.fuelish.CAR_CONNECTED"
        const val ACTION_CAR_DISCONNECTED = "app.fuelish.CAR_DISCONNECTED"
        const val ACTION_LEFT_VEHICLE = "app.fuelish.LEFT_VEHICLE"
        private val ADAPTER_CUES = setOf(DriveWatch.Kind.ADAPTER_NOT_CONNECTING, DriveWatch.Kind.ADAPTER_LOST, DriveWatch.Kind.ADAPTER_BACK)
        const val EXTRA_NOTE = "note"
        const val EXTRA_TRIGGER = "trigger"
        const val EXTRA_RESUMES = "resumes"
        const val TRIGGER_MANUAL = "manual"
        const val CHANNEL = "recording"
        private const val NOTIFICATION_ID = 1
        private const val NOT_KEPT_NOTIFICATION_ID = 5

        @Volatile var activeId: String? = null

        fun createChannel(c: Context) {
            c.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW),
            )
        }

        /** [resumes]: the recording an app update cut short, which this one carries on. */
        fun start(c: Context, note: String, trigger: String = TRIGGER_MANUAL, resumes: String? = null) {
            c.startForegroundService(
                Intent(c, RecorderService::class.java).setAction(ACTION_START).putExtra(EXTRA_NOTE, note).putExtra(EXTRA_TRIGGER, trigger)
                    .apply { if (resumes != null) putExtra(EXTRA_RESUMES, resumes) },
            )
        }

        fun stop(c: Context) {
            c.startService(Intent(c, RecorderService::class.java).setAction(ACTION_STOP))
        }
    }
}
