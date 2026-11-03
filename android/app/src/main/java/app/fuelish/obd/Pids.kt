package app.fuelish.obd

/** One decoded quantity from a PID response. `bytes` are the PID's data bytes (A, B, C, ...). */
data class PidField(val name: String, val unit: String, val formula: String, val decode: (IntArray) -> Double)

/** Standard SAE J1979 mode 01 PID definition. Only PIDs the car reports as supported are polled. */
data class PidDef(val pid: Int, val name: String, val bytes: Int, val fields: List<PidField>)

object Pids {
    private fun u16(b: IntArray, i: Int = 0) = (b[i] shl 8 or b[i + 1]).toDouble()
    private fun s16(b: IntArray, i: Int = 0) = (((b[i] shl 8) or b[i + 1]).toShort()).toDouble()

    private fun pct(n: String) = PidField(n, "%", "A*100/255") { it[0] * 100.0 / 255 }
    private fun temp(n: String) = PidField(n, "degC", "A-40") { it[0] - 40.0 }
    private fun trim(n: String, i: Int = 0) = PidField(n, "%", "(X-128)*100/128") { (it[i] - 128) * 100.0 / 128 }
    private fun raw(n: String) = PidField(n, "raw", "A") { it[0].toDouble() }

    private fun one(pid: Int, name: String, bytes: Int, f: PidField) = PidDef(pid, name, bytes, listOf(f))

    private fun o2Narrow(pid: Int, sensor: String) = PidDef(
        pid, "o2_$sensor", 2,
        listOf(
            PidField("o2_${sensor}_v", "V", "A/200") { it[0] / 200.0 },
            PidField("o2_${sensor}_stft", "%", "(B-128)*100/128 (255 = not used)") { if (it[1] == 0xFF) Double.NaN else (it[1] - 128) * 100.0 / 128 },
        ),
    )

    private fun o2WideV(pid: Int, sensor: String) = PidDef(
        pid, "o2w_$sensor", 4,
        listOf(
            PidField("o2w_${sensor}_lambda", "ratio", "2/65536*(256A+B)") { 2.0 / 65536 * u16(it) },
            PidField("o2w_${sensor}_v", "V", "8/65536*(256C+D)") { 8.0 / 65536 * u16(it, 2) },
        ),
    )

    private fun o2WideI(pid: Int, sensor: String) = PidDef(
        pid, "o2wi_$sensor", 4,
        listOf(
            PidField("o2wi_${sensor}_lambda", "ratio", "2/65536*(256A+B)") { 2.0 / 65536 * u16(it) },
            PidField("o2wi_${sensor}_ma", "mA", "(256C+D)/256-128") { u16(it, 2) / 256 - 128 },
        ),
    )

    private val sensors = listOf("b1s1", "b1s2", "b1s3", "b1s4", "b2s1", "b2s2", "b2s3", "b2s4")

    val all: Map<Int, PidDef> = buildList {
        add(PidDef(0x01, "monitor_status", 4, listOf(PidField("mil_on", "bool", "A bit7") { if (it[0] and 0x80 != 0) 1.0 else 0.0 }, PidField("dtc_count", "count", "A & 0x7F") { (it[0] and 0x7F).toDouble() })))
        add(PidDef(0x03, "fuel_system_status", 2, listOf(PidField("fuel_sys1", "enum", "A") { it[0].toDouble() }, PidField("fuel_sys2", "enum", "B") { it[1].toDouble() })))
        add(one(0x04, "engine_load", 1, pct("engine_load")))
        add(one(0x05, "coolant_temp", 1, temp("coolant_temp")))
        add(one(0x06, "stft_b1", 1, trim("stft_b1")))
        add(one(0x07, "ltft_b1", 1, trim("ltft_b1")))
        add(one(0x08, "stft_b2", 1, trim("stft_b2")))
        add(one(0x09, "ltft_b2", 1, trim("ltft_b2")))
        add(one(0x0A, "fuel_pressure", 1, PidField("fuel_pressure", "kPa", "3A") { it[0] * 3.0 }))
        add(one(0x0B, "map", 1, PidField("map", "kPa", "A") { it[0].toDouble() }))
        add(one(0x0C, "rpm", 2, PidField("rpm", "rpm", "(256A+B)/4") { u16(it) / 4 }))
        add(one(0x0D, "speed", 1, PidField("speed", "km/h", "A") { it[0].toDouble() }))
        add(one(0x0E, "timing_advance", 1, PidField("timing_advance", "deg", "A/2-64") { it[0] / 2.0 - 64 }))
        add(one(0x0F, "iat", 1, temp("iat")))
        add(one(0x10, "maf", 2, PidField("maf", "g/s", "(256A+B)/100") { u16(it) / 100 }))
        add(one(0x11, "throttle", 1, pct("throttle")))
        add(one(0x12, "secondary_air_status", 1, raw("secondary_air_status")))
        add(one(0x13, "o2_present", 1, raw("o2_present")))
        for (i in 0..7) add(o2Narrow(0x14 + i, sensors[i]))
        add(one(0x1C, "obd_standard", 1, raw("obd_standard")))
        add(one(0x1D, "o2_present_alt", 1, raw("o2_present_alt")))
        add(one(0x1E, "aux_input", 1, raw("aux_input")))
        add(one(0x1F, "run_time", 2, PidField("run_time", "s", "256A+B") { u16(it) }))
        add(one(0x21, "distance_mil", 2, PidField("distance_mil", "km", "256A+B") { u16(it) }))
        add(one(0x22, "fuel_rail_pressure_rel", 2, PidField("fuel_rail_pressure_rel", "kPa", "0.079*(256A+B)") { 0.079 * u16(it) }))
        add(one(0x23, "fuel_rail_pressure", 2, PidField("fuel_rail_pressure", "kPa", "10*(256A+B)") { 10 * u16(it) }))
        for (i in 0..7) add(o2WideV(0x24 + i, sensors[i]))
        add(one(0x2C, "egr_cmd", 1, pct("egr_cmd")))
        add(one(0x2D, "egr_error", 1, trim("egr_error")))
        add(one(0x2E, "evap_purge_cmd", 1, pct("evap_purge_cmd")))
        add(one(0x2F, "fuel_level", 1, pct("fuel_level")))
        add(one(0x30, "warmups_since_clear", 1, PidField("warmups_since_clear", "count", "A") { it[0].toDouble() }))
        add(one(0x31, "distance_since_clear", 2, PidField("distance_since_clear", "km", "256A+B") { u16(it) }))
        add(one(0x32, "evap_vapor_pressure", 2, PidField("evap_vapor_pressure", "Pa", "signed(256A+B)/4") { s16(it) / 4 }))
        add(one(0x33, "baro", 1, PidField("baro", "kPa", "A") { it[0].toDouble() }))
        for (i in 0..7) add(o2WideI(0x34 + i, sensors[i]))
        add(one(0x3C, "cat_temp_b1s1", 2, PidField("cat_temp_b1s1", "degC", "(256A+B)/10-40") { u16(it) / 10 - 40 }))
        add(one(0x3D, "cat_temp_b2s1", 2, PidField("cat_temp_b2s1", "degC", "(256A+B)/10-40") { u16(it) / 10 - 40 }))
        add(one(0x3E, "cat_temp_b1s2", 2, PidField("cat_temp_b1s2", "degC", "(256A+B)/10-40") { u16(it) / 10 - 40 }))
        add(one(0x3F, "cat_temp_b2s2", 2, PidField("cat_temp_b2s2", "degC", "(256A+B)/10-40") { u16(it) / 10 - 40 }))
        add(one(0x41, "monitor_status_cycle", 4, raw("monitor_status_cycle")))
        add(one(0x42, "module_voltage", 2, PidField("module_voltage", "V", "(256A+B)/1000") { u16(it) / 1000 }))
        add(one(0x43, "abs_load", 2, PidField("abs_load", "%", "(256A+B)*100/255") { u16(it) * 100 / 255 }))
        add(one(0x44, "commanded_lambda", 2, PidField("commanded_lambda", "ratio", "2/65536*(256A+B)") { 2.0 / 65536 * u16(it) }))
        add(one(0x45, "rel_throttle", 1, pct("rel_throttle")))
        add(one(0x46, "ambient_temp", 1, temp("ambient_temp")))
        add(one(0x47, "abs_throttle_b", 1, pct("abs_throttle_b")))
        add(one(0x48, "abs_throttle_c", 1, pct("abs_throttle_c")))
        add(one(0x49, "accel_pedal_d", 1, pct("accel_pedal_d")))
        add(one(0x4A, "accel_pedal_e", 1, pct("accel_pedal_e")))
        add(one(0x4B, "accel_pedal_f", 1, pct("accel_pedal_f")))
        add(one(0x4C, "throttle_actuator_cmd", 1, pct("throttle_actuator_cmd")))
        add(one(0x4D, "time_with_mil", 2, PidField("time_with_mil", "min", "256A+B") { u16(it) }))
        add(one(0x4E, "time_since_clear", 2, PidField("time_since_clear", "min", "256A+B") { u16(it) }))
        add(one(0x51, "fuel_type", 1, raw("fuel_type")))
        add(one(0x52, "ethanol_pct", 1, pct("ethanol_pct")))
        add(one(0x53, "evap_abs_pressure", 2, PidField("evap_abs_pressure", "kPa", "(256A+B)/200") { u16(it) / 200 }))
        add(one(0x54, "evap_pressure2", 2, PidField("evap_pressure2", "Pa", "signed(256A+B)") { s16(it) }))
        add(PidDef(0x55, "st_o2_trim_b1b3", 2, listOf(trim("st_o2_trim_b1", 0), trim("st_o2_trim_b3", 1))))
        add(PidDef(0x56, "lt_o2_trim_b1b3", 2, listOf(trim("lt_o2_trim_b1", 0), trim("lt_o2_trim_b3", 1))))
        add(PidDef(0x57, "st_o2_trim_b2b4", 2, listOf(trim("st_o2_trim_b2", 0), trim("st_o2_trim_b4", 1))))
        add(PidDef(0x58, "lt_o2_trim_b2b4", 2, listOf(trim("lt_o2_trim_b2", 0), trim("lt_o2_trim_b4", 1))))
        add(one(0x59, "fuel_rail_abs_pressure", 2, PidField("fuel_rail_abs_pressure", "kPa", "10*(256A+B)") { 10 * u16(it) }))
        add(one(0x5A, "rel_accel_pedal", 1, pct("rel_accel_pedal")))
        add(one(0x5B, "hybrid_battery_pct", 1, pct("hybrid_battery_pct")))
        add(one(0x5C, "oil_temp", 1, temp("oil_temp")))
        add(one(0x5D, "injection_timing", 2, PidField("injection_timing", "deg", "(256A+B)/128-210") { u16(it) / 128 - 210 }))
        add(one(0x5E, "fuel_rate", 2, PidField("fuel_rate", "L/h", "(256A+B)/20") { u16(it) / 20 }))
        add(one(0x5F, "emission_req", 1, raw("emission_req")))
        add(one(0x61, "demand_torque", 1, PidField("demand_torque", "%", "A-125") { it[0] - 125.0 }))
        add(one(0x62, "actual_torque", 1, PidField("actual_torque", "%", "A-125") { it[0] - 125.0 }))
        add(one(0x63, "reference_torque", 2, PidField("reference_torque", "Nm", "256A+B") { u16(it) }))
        add(one(0xA6, "odometer", 4, PidField("odometer", "km", "(A<<24|B<<16|C<<8|D)/10") { ((it[0].toLong() shl 24) or (it[1].toLong() shl 16) or (it[2].toLong() shl 8) or it[3].toLong()) / 10.0 }))
    }.associateBy { it.pid }

    /** PIDs 0x00, 0x20, ... return 4-byte bitmaps of which of the next 32 PIDs are supported. */
    fun isBitmapPid(pid: Int) = pid % 0x20 == 0

    fun decodeBitmap(base: Int, data: IntArray): List<Int> {
        val out = mutableListOf<Int>()
        for (i in 0 until 32) {
            val byte = data[i / 8]
            if (byte and (0x80 shr (i % 8)) != 0) out += base + i + 1
        }
        return out
    }

    fun hex(pid: Int) = "%02X".format(pid)
}

/** A decoded value from one PID in a mode 01 response. */
data class PidValue(val pid: Int, val data: IntArray, val def: PidDef?)

object Mode01 {
    /**
     * Splits a mode 01 response payload (`41 pid data [pid data ...]`) into PIDs using the
     * known data lengths. [requested] lets a single unknown-length PID take the remainder.
     */
    fun split(payload: ByteArray, requested: List<Int>): List<PidValue> {
        if (payload.isEmpty() || payload[0].toInt() and 0xFF != 0x41) return emptyList()
        val b = IntArray(payload.size) { payload[it].toInt() and 0xFF }
        val out = mutableListOf<PidValue>()
        var i = 1
        while (i < b.size) {
            val pid = b[i]
            val def = Pids.all[pid]
            val len = when {
                Pids.isBitmapPid(pid) -> 4
                def != null -> def.bytes
                requested.size == 1 && requested[0] == pid -> b.size - i - 1
                else -> return out // can't know where this PID ends
            }
            if (i + 1 + len > b.size) return out
            out += PidValue(pid, b.copyOfRange(i + 1, i + 1 + len), def)
            i += 1 + len
        }
        return out
    }
}
