package app.fuelish.obd

/**
 * A parked test of the OBD adapter for setup: does the adapter answer, does the car answer through
 * it, what's the VIN, and can Fuelish work out fuel use from what the car reports. Read-only, like
 * everything sent to the adapter (see [ElmAllowlist]). Blocking: run off the main thread.
 */
object AdapterCheck {
    data class Result(
        /** The adapter answered over Bluetooth. */
        val adapterOk: Boolean,
        /** The car answered through the adapter. */
        val carOk: Boolean = false,
        val adapterName: String = "",
        val volts: String = "",
        val vin: String = "",
        val fuel: Fuel = Fuel.UNKNOWN,
        val speed: Boolean = false,
        /** Why it stopped, when it did (in words for the person, not a stack trace). */
        val problem: String = "",
    ) {
        /** The adapter and the car both answer: setup is done (fuel readings or not, nothing more can be fixed here). */
        val ok get() = adapterOk && carOk
    }

    enum class Fuel {
        /** The car reports its fuel rate (PID 5E). */
        REPORTED,
        /** Estimated from the mass airflow sensor (PID 10). */
        AIRFLOW,
        /** Neither: trips get GPS, time and cost of time, but no gallons or mpg. */
        NONE,
        UNKNOWN,
    }

    fun run(transport: ObdTransport, nanoTime: () -> Long = System::nanoTime): Result {
        val s = ElmSession(transport, nanoTime)
        val z = s.cmd("ATZ", 5_000)
        if (z.status == ElmStatus.TIMEOUT) return Result(false, problem = "The adapter connected but didn't answer. Unplug it, plug it back in, and try again.")
        for (c in listOf("ATE0", "ATL0", "ATS0", "ATH1", "ATSP0")) s.cmd(c)
        val name = s.cmd("STDI").takeIf { it.status == ElmStatus.OK }?.lines?.firstOrNull()
            ?: s.cmd("ATI").lines.firstOrNull().orEmpty()
        val volts = s.cmd("ATRV").lines.firstOrNull().orEmpty()
        val base = Result(true, adapterName = name, volts = volts)

        val first = s.cmd("0100", 15_000)
        if (first.status != ElmStatus.OK) {
            return base.copy(problem = "The adapter works, but the car didn't answer. Turn the car on (engine running or ignition on) and try again.")
        }
        val protocol = s.cmd("ATDPN").lines.firstOrNull().orEmpty().removePrefix("A").toIntOrNull(16) ?: 0
        val supported = sortedSetOf<Int>()
        var resp = first
        var b = 0x00
        while (true) {
            for (m in ObdParser.parse(resp.lines, protocol)) {
                val v = Mode01.split(m.payload, listOf(b)).firstOrNull { it.pid == b } ?: continue
                supported += Pids.decodeBitmap(b, v.data)
            }
            val next = b + 0x20
            if (next > 0xE0 || next !in supported) break
            b = next
            resp = s.cmd("01" + Pids.hex(b))
            if (resp.status != ElmStatus.OK) break
        }
        if (supported.none { !Pids.isBitmapPid(it) }) {
            return base.copy(problem = "The car answered but didn't list any readings. Try again with the engine running.")
        }
        val vinResp = s.cmd("0902", 5_000)
        val vin = ObdParser.parse(vinResp.lines, protocol).firstOrNull()?.payload?.drop(3)
            ?.map { it.toInt().toChar() }?.filter { it.isLetterOrDigit() }?.joinToString("").orEmpty()
            .takeIf { it.length == 17 }.orEmpty()
        val fuel = when {
            0x5E in supported -> Fuel.REPORTED
            0x10 in supported -> Fuel.AIRFLOW
            else -> Fuel.NONE
        }
        return base.copy(carOk = true, vin = vin, fuel = fuel, speed = 0x0D in supported)
    }
}
