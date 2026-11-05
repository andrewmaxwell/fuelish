package app.fuelish.sensors

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.GnssMeasurementRequest
import android.location.GnssMeasurementsEvent
import android.location.GnssNavigationMessage
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.GnssCapabilities
import android.location.LocationManager
import android.location.LocationRequest
import android.location.OnNmeaMessageListener
import android.os.Build
import android.os.Handler
import android.os.SystemClock
import app.fuelish.Config
import app.fuelish.record.JsonLine
import app.fuelish.record.RecordSink
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicLong

/**
 * Phone sensors, locations and GNSS. All callbacks run on [handler]'s thread and only
 * format a line and hand it to the sink; the writer thread does all I/O.
 *
 * Times: sensor `ts` is SensorEvent.timestamp (sample time) and `rx` is when the callback
 * ran, both on the elapsedRealtimeNanos clock, so batching delay is visible as rx - ts.
 */
class PhoneSensors(
    private val context: Context,
    private val config: Config,
    private val sink: RecordSink,
    private val handler: Handler,
) {
    private val sm = context.getSystemService(SensorManager::class.java)
    private val lm = context.getSystemService(LocationManager::class.java)
    private val executor = Executor { handler.post(it) }

    /** Samples received per stream, for live rates on the status screen. */
    val counts = ConcurrentHashMap<String, AtomicLong>()
    @Volatile var lastGps: Location? = null
        private set
    @Volatile var satellitesUsed = 0
        private set
    @Volatile var satellitesVisible = 0
        private set
    val problems = mutableListOf<String>()

    /** Largest |‖a‖ − g| from the accelerometer since the last GPS fix (m/s²); NaN if none. */
    private var joltSinceFix = Double.NaN

    private val listeners = mutableListOf<SensorEventListener>()
    private val locationListeners = mutableListOf<LocationListener>()
    private var gnssStatusCallback: GnssStatus.Callback? = null
    private var measurementsCallback: GnssMeasurementsEvent.Callback? = null
    private var navCallback: GnssNavigationMessage.Callback? = null
    private var nmeaListener: OnNmeaMessageListener? = null

    private fun count(stream: String) = counts.getOrPut(stream) { AtomicLong() }.incrementAndGet()

    private fun now() = SystemClock.elapsedRealtimeNanos()

    private fun emit(stream: String, t: Long, line: String, track: DoubleArray? = null) {
        count(stream)
        sink.emit(stream, t, line, track)
    }

    fun start() {
        writeSensorList()
        startSensors()
        startLocation()
    }

    fun stop() {
        listeners.forEach { sm.unregisterListener(it) }
        listeners.clear()
        locationListeners.forEach { lm.removeUpdates(it) }
        locationListeners.clear()
        gnssStatusCallback?.let { lm.unregisterGnssStatusCallback(it) }
        measurementsCallback?.let { lm.unregisterGnssMeasurementsCallback(it) }
        navCallback?.let { lm.unregisterGnssNavigationMessageCallback(it) }
        nmeaListener?.let { lm.removeNmeaListener(it) }
    }

    private fun sensorJson(l: JsonLine, s: Sensor) {
        l.s("name", s.name).s("vendor", s.vendor).n("version", s.version).n("type", s.type).s("stringType", s.stringType)
            .n("id", s.id).f("resolution", s.resolution).f("maxRange", s.maximumRange).f("powerMa", s.power)
            .n("minDelayUs", s.minDelay).n("maxDelayUs", s.maxDelay).n("fifoReserved", s.fifoReservedEventCount)
            .n("fifoMax", s.fifoMaxEventCount).b("wakeUp", s.isWakeUpSensor).n("reportingMode", s.reportingMode)
            .b("dynamic", s.isDynamicSensor).n("directRateLevel", s.highestDirectReportRateLevel)
    }

    private fun writeSensorList() {
        val now = now()
        val l = JsonLine("sensor_list", 8192).n("rx", now)
        l.arr("sensors") { sm.getSensorList(Sensor.TYPE_ALL).forEach { s -> arrObj { sensorJson(this, s) } } }
        sink.emit("sensor_list", now, l.build())
    }

    private fun startSensors() {
        val latencyUs = config.sensorMaxLatencyMs * 1000
        for ((key, hz) in config.sensors) {
            if (hz == 0.0) continue
            val type = SENSOR_TYPES[key]
            if (type == null) {
                problems += "unknown sensor key $key"
                continue
            }
            val sensor = sm.getDefaultSensor(type)
            val now = now()
            val info = JsonLine("sensor_info", 600).n("rx", now).s("s", key).d("requestedHz", hz)
            if (sensor == null) {
                sink.emit("sensor_info", now, info.b("present", false).build())
                continue
            }
            val periodUs = if (hz < 0) SensorManager.SENSOR_DELAY_FASTEST else (1_000_000 / hz).toInt()
            val stream = "s:$key"
            val listener = object : SensorEventListener {
                override fun onSensorChanged(e: SensorEvent) {
                    val rx = now()
                    if (type == Sensor.TYPE_ACCELEROMETER) {
                        val v = e.values
                        val dev = kotlin.math.abs(kotlin.math.sqrt((v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).toDouble()) - SensorManager.GRAVITY_EARTH)
                        if (joltSinceFix.isNaN() || dev > joltSinceFix) joltSinceFix = dev
                    }
                    emit(stream, e.timestamp, JsonLine("s", 120).s("s", key).n("ts", e.timestamp).n("rx", rx).floats("v", e.values).n("a", e.accuracy).build())
                }

                override fun onAccuracyChanged(s: Sensor, accuracy: Int) {
                    val rx = now()
                    sink.emit("accuracy", rx, JsonLine("accuracy").s("s", key).n("rx", rx).n("a", accuracy).build())
                }
            }
            val ok = sm.registerListener(listener, sensor, periodUs, latencyUs, handler)
            if (ok) listeners += listener else problems += "could not register $key"
            info.b("present", true).n("periodUs", periodUs).n("maxLatencyUs", latencyUs).b("registered", ok)
            info.beginObj("sensor")
            sensorJson(info, sensor)
            info.endObj()
            sink.emit("sensor_info", now, info.build())
        }
    }

    @SuppressLint("MissingPermission") // checked by the activity before starting the service
    private fun startLocation() {
        val loc = config.location
        val now = now()
        val caps = lm.gnssCapabilities
        sink.emit(
            "gnss_info", now,
            JsonLine("gnss_info").n("rx", now).s("hardwareModel", lm.gnssHardwareModelName).n("yearOfHardware", lm.gnssYearOfHardware)
                .b("measurements", caps.hasMeasurements()).b("navigationMessages", caps.hasNavigationMessages())
                .b("antennaInfo", caps.hasAntennaInfo())
                .b("accumulatedDeltaRange", if (Build.VERSION.SDK_INT >= 34) caps.hasAccumulatedDeltaRange() == GnssCapabilities.CAPABILITY_SUPPORTED else false)
                .b("gpsEnabled", lm.isProviderEnabled(LocationManager.GPS_PROVIDER)).build(),
        )

        fun request(provider: String, intervalMs: Long) {
            if (intervalMs < 0 || !lm.hasProvider(provider)) {
                if (intervalMs >= 0) problems += "no $provider provider"
                return
            }
            val stream = "loc:$provider"
            val listener = object : LocationListener {
                override fun onLocationChanged(l: Location) {
                    var track: DoubleArray? = null
                    if (provider == LocationManager.GPS_PROVIDER) {
                        lastGps = l
                        track = doubleArrayOf(
                            l.time.toDouble(), round(l.latitude, 6), round(l.longitude, 6),
                            if (l.hasSpeed()) round(l.speed.toDouble(), 2) else Double.NaN,
                            if (l.hasAccuracy()) round(l.accuracy.toDouble(), 1) else Double.NaN,
                            if (l.hasBearing()) round(l.bearing.toDouble(), 0) else Double.NaN,
                            round(joltSinceFix, 2),
                        )
                        joltSinceFix = Double.NaN
                    }
                    emit(stream, l.elapsedRealtimeNanos, locationLine(l, provider), track)
                }

                override fun onProviderEnabled(p: String) = providerEvent(p, true)
                override fun onProviderDisabled(p: String) = providerEvent(p, false)
            }
            val req = LocationRequest.Builder(intervalMs).setQuality(LocationRequest.QUALITY_HIGH_ACCURACY)
                .setMinUpdateIntervalMillis(0).setMaxUpdateDelayMillis(0).build()
            lm.requestLocationUpdates(provider, req, executor, listener)
            locationListeners += listener
        }
        request(LocationManager.GPS_PROVIDER, loc.optLong("gpsIntervalMs", 100))
        val fused = loc.optLong("fusedIntervalMs", 1000)
        if (fused > 0) request(LocationManager.FUSED_PROVIDER, fused)

        if (loc.optBoolean("gnssStatus", true)) {
            val cb = object : GnssStatus.Callback() {
                override fun onSatelliteStatusChanged(st: GnssStatus) = gnssStatus(st)
            }
            lm.registerGnssStatusCallback(executor, cb)
            gnssStatusCallback = cb
        }
        if (loc.optBoolean("gnssMeasurements", true) && caps.hasMeasurements()) {
            val cb = object : GnssMeasurementsEvent.Callback() {
                override fun onGnssMeasurementsReceived(e: GnssMeasurementsEvent) = gnssMeasurements(e)
            }
            val req = GnssMeasurementRequest.Builder().setFullTracking(loc.optBoolean("gnssFullTracking", false)).build()
            lm.registerGnssMeasurementsCallback(req, executor, cb)
            measurementsCallback = cb
        }
        if (loc.optBoolean("gnssNavigationMessages", false) && caps.hasNavigationMessages()) {
            val cb = object : GnssNavigationMessage.Callback() {
                override fun onGnssNavigationMessageReceived(m: GnssNavigationMessage) {
                    val rx = now()
                    emit("gnss_nav", rx, JsonLine("gnss_nav").n("rx", rx).n("type", m.type).n("svid", m.svid).n("msgId", m.messageId)
                        .n("submsgId", m.submessageId).n("status", m.status).s("data", m.data.joinToString("") { "%02x".format(it) }).build())
                }
            }
            lm.registerGnssNavigationMessageCallback(executor, cb)
            navCallback = cb
        }
        if (loc.optBoolean("nmea", false)) {
            val l = OnNmeaMessageListener { msg, ts ->
                val rx = now()
                emit("nmea", rx, JsonLine("nmea").n("rx", rx).n("ts", ts).s("msg", msg.trim()).build())
            }
            lm.addNmeaListener(executor, l)
            nmeaListener = l
        }
    }

    private fun round(x: Double, digits: Int): Double {
        if (!x.isFinite()) return x
        val f = Math.pow(10.0, digits.toDouble())
        return Math.round(x * f) / f
    }

    private fun providerEvent(p: String, enabled: Boolean) {
        val rx = now()
        sink.emit("event", rx, JsonLine("event").n("rx", rx).s("ev", "provider_" + if (enabled) "enabled" else "disabled").s("provider", p).build())
    }

    private fun locationLine(l: Location, provider: String): String {
        val j = JsonLine("loc", 400).s("p", provider).n("et", l.elapsedRealtimeNanos).n("rx", now()).n("time", l.time)
            .d("lat", l.latitude).d("lon", l.longitude)
        if (l.hasElapsedRealtimeUncertaintyNanos()) j.d("etUnc", l.elapsedRealtimeUncertaintyNanos)
        if (l.hasAltitude()) j.d("alt", l.altitude)
        if (Build.VERSION.SDK_INT >= 34) {
            if (l.hasMslAltitude()) j.d("msl", l.mslAltitudeMeters)
            if (l.hasMslAltitudeAccuracy()) j.f("mslAcc", l.mslAltitudeAccuracyMeters)
        }
        if (l.hasAccuracy()) j.f("hAcc", l.accuracy)
        if (l.hasVerticalAccuracy()) j.f("vAcc", l.verticalAccuracyMeters)
        if (l.hasSpeed()) j.f("speed", l.speed)
        if (l.hasSpeedAccuracy()) j.f("speedAcc", l.speedAccuracyMetersPerSecond)
        if (l.hasBearing()) j.f("bearing", l.bearing)
        if (l.hasBearingAccuracy()) j.f("bearingAcc", l.bearingAccuracyDegrees)
        l.extras?.let { if (it.containsKey("satellites")) j.n("sats", it.getInt("satellites")) }
        j.b("mock", l.isMock)
        return j.build()
    }

    private fun gnssStatus(st: GnssStatus) {
        val rx = now()
        var used = 0
        val j = JsonLine("gnss_status", 4096).n("rx", rx).n("n", st.satelliteCount)
        j.arr("sv") {
            for (i in 0 until st.satelliteCount) {
                if (st.usedInFix(i)) used++
                arrObj {
                    n("c", st.getConstellationType(i)).n("svid", st.getSvid(i)).f("cn0", st.getCn0DbHz(i))
                        .f("el", st.getElevationDegrees(i)).f("az", st.getAzimuthDegrees(i)).b("used", st.usedInFix(i))
                        .b("eph", st.hasEphemerisData(i)).b("alm", st.hasAlmanacData(i))
                    if (st.hasCarrierFrequencyHz(i)) f("cf", st.getCarrierFrequencyHz(i))
                    if (st.hasBasebandCn0DbHz(i)) f("bbCn0", st.getBasebandCn0DbHz(i))
                }
            }
        }
        j.n("used", used)
        satellitesUsed = used
        satellitesVisible = st.satelliteCount
        emit("gnss_status", rx, j.build())
    }

    private fun gnssMeasurements(e: GnssMeasurementsEvent) {
        val rx = now()
        val c = e.clock
        val j = JsonLine("gnss_meas", 8192).n("rx", rx)
        j.obj("clock") {
            n("timeNs", c.timeNanos).n("hwDisc", c.hardwareClockDiscontinuityCount)
            if (c.hasFullBiasNanos()) n("fullBiasNs", c.fullBiasNanos)
            if (c.hasBiasNanos()) d("biasNs", c.biasNanos)
            if (c.hasBiasUncertaintyNanos()) d("biasUncNs", c.biasUncertaintyNanos)
            if (c.hasDriftNanosPerSecond()) d("drift", c.driftNanosPerSecond)
            if (c.hasDriftUncertaintyNanosPerSecond()) d("driftUnc", c.driftUncertaintyNanosPerSecond)
            if (c.hasLeapSecond()) n("leap", c.leapSecond)
            if (c.hasTimeUncertaintyNanos()) d("timeUncNs", c.timeUncertaintyNanos)
            if (c.hasElapsedRealtimeNanos()) n("et", c.elapsedRealtimeNanos)
            if (c.hasElapsedRealtimeUncertaintyNanos()) d("etUnc", c.elapsedRealtimeUncertaintyNanos)
        }
        j.arr("m") {
            for (m in e.measurements) arrObj {
                n("svid", m.svid).n("c", m.constellationType).d("tOff", m.timeOffsetNanos).n("state", m.state)
                    .n("rsTow", m.receivedSvTimeNanos).n("rsTowUnc", m.receivedSvTimeUncertaintyNanos).d("cn0", m.cn0DbHz)
                    .d("prr", m.pseudorangeRateMetersPerSecond).d("prrUnc", m.pseudorangeRateUncertaintyMetersPerSecond)
                    .n("adrState", m.accumulatedDeltaRangeState).d("adr", m.accumulatedDeltaRangeMeters)
                    .d("adrUnc", m.accumulatedDeltaRangeUncertaintyMeters).n("mp", m.multipathIndicator)
                if (m.hasCarrierFrequencyHz()) f("cf", m.carrierFrequencyHz)
                if (m.hasAutomaticGainControlLevelDb()) d("agc", m.automaticGainControlLevelDb)
                if (m.hasBasebandCn0DbHz()) d("bbCn0", m.basebandCn0DbHz)
                if (m.hasSnrInDb()) d("snr", m.snrInDb)
                if (m.hasCodeType()) s("code", m.codeType)
                if (m.hasFullInterSignalBiasNanos()) d("isb", m.fullInterSignalBiasNanos)
                if (m.hasSatelliteInterSignalBiasNanos()) d("satIsb", m.satelliteInterSignalBiasNanos)
            }
        }
        emit("gnss_meas", rx, j.build())
    }

    companion object {
        val SENSOR_TYPES = buildMap {
            put("acc", Sensor.TYPE_ACCELEROMETER)
            put("acc_unc", Sensor.TYPE_ACCELEROMETER_UNCALIBRATED)
            put("gyro", Sensor.TYPE_GYROSCOPE)
            put("gyro_unc", Sensor.TYPE_GYROSCOPE_UNCALIBRATED)
            put("mag", Sensor.TYPE_MAGNETIC_FIELD)
            put("mag_unc", Sensor.TYPE_MAGNETIC_FIELD_UNCALIBRATED)
            put("gravity", Sensor.TYPE_GRAVITY)
            put("linacc", Sensor.TYPE_LINEAR_ACCELERATION)
            put("rotvec", Sensor.TYPE_ROTATION_VECTOR)
            put("gamerot", Sensor.TYPE_GAME_ROTATION_VECTOR)
            put("georot", Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR)
            put("pressure", Sensor.TYPE_PRESSURE)
            put("light", Sensor.TYPE_LIGHT)
            put("prox", Sensor.TYPE_PROXIMITY)
            put("temp", Sensor.TYPE_AMBIENT_TEMPERATURE)
            put("humidity", Sensor.TYPE_RELATIVE_HUMIDITY)
            if (Build.VERSION.SDK_INT >= 33) put("heading", Sensor.TYPE_HEADING)
        }
    }
}
