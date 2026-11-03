package app.fuelish.sensors

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import app.fuelish.record.JsonLine
import app.fuelish.record.RecordSink
import org.json.JSONObject

/** Periodic battery/thermal/CPU samples so each recording carries its own cost. */
class PowerMonitor(private val context: Context, private val sink: RecordSink) {
    private val bm = context.getSystemService(BatteryManager::class.java)
    private val pm = context.getSystemService(PowerManager::class.java)

    data class Sample(val pct: Int, val chargeUah: Long, val currentUa: Long, val plugged: Int, val tempC: Double, val elapsedNs: Long)

    private var first: Sample? = null
    @Volatile var last: Sample? = null
        private set
    private var pluggedNs = 0L
    private var cpuStartMs = Process.getElapsedCpuTime()

    fun sample(): Sample {
        val now = SystemClock.elapsedRealtimeNanos()
        val i = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = i?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val tempC = (i?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0
        val s = Sample(
            pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY),
            chargeUah = bm.getLongProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER),
            currentUa = bm.getLongProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW),
            plugged = plugged,
            tempC = tempC,
            elapsedNs = now,
        )
        val prev = last
        if (prev != null && prev.plugged != 0) pluggedNs += now - prev.elapsedNs
        if (first == null) first = s
        last = s
        sink.emit(
            "batt", now,
            JsonLine("batt").n("rx", now).n("pct", s.pct).n("chargeUah", s.chargeUah).n("currentUa", s.currentUa)
                .n("currentAvgUa", bm.getLongProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE))
                .n("mv", i?.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0) ?: 0).d("tempC", tempC)
                .n("status", i?.getIntExtra(BatteryManager.EXTRA_STATUS, 0) ?: 0).n("plugged", plugged)
                .n("thermal", pm.currentThermalStatus).b("powerSave", pm.isPowerSaveMode)
                .n("cpuMs", Process.getElapsedCpuTime()).build(),
        )
        return s
    }

    fun summary(): JSONObject {
        val f = first ?: return JSONObject()
        val l = last ?: f
        val hours = (l.elapsedNs - f.elapsedNs) / 3.6e12
        return JSONObject().put("startPct", f.pct).put("endPct", l.pct)
            .put("startChargeUah", f.chargeUah).put("endChargeUah", l.chargeUah)
            .put("pctPerHour", if (hours > 0.01) (f.pct - l.pct) / hours else JSONObject.NULL)
            .put("pluggedFraction", if (l.elapsedNs > f.elapsedNs) pluggedNs.toDouble() / (l.elapsedNs - f.elapsedNs) else JSONObject.NULL)
            .put("cpuMs", Process.getElapsedCpuTime() - cpuStartMs)
            .put("note", "pctPerHour is only meaningful while unplugged (see pluggedFraction)")
    }
}
