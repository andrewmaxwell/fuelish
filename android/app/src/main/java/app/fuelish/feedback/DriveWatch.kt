package app.fuelish.feedback

import java.util.Locale

/**
 * What the driver hears about during a drive, decided once a second from the recorder's state.
 * Each cue is said once, not repeated while the condition lasts:
 *
 * - The adapter never answered 90 s into a drive it should be in (and the phone is moving), or it
 *   answered and then the link dropped for 20 s while moving. A link that drops after the car stopped
 *   answering is the car being switched off (the adapter goes to sleep), not a problem. When it comes
 *   back after a drop, that's said too.
 * - The check-engine light came on (compared with the last reading on any earlier drive, so a light
 *   that stays on isn't announced every drive).
 * - Coolant at [HOT_C] or more for 30 s (normal is about 90–105 °C); said again only after it cools
 *   below [COOL_C].
 * - Under [LOW_VOLTS] for 60 s with the engine running: the battery is discharging, so the car isn't
 *   charging it. Some cars let charging voltage dip to about 12.5 V to save fuel, so the line is lower.
 *
 * Engine values count only while the engine is answering; the last reading of a gone link isn't news.
 */
class DriveWatch(private val expectAdapter: Boolean, milWasOn: Boolean) {
    enum class Kind { ADAPTER_NOT_CONNECTING, ADAPTER_LOST, ADAPTER_BACK, CHECK_ENGINE, ENGINE_HOT, NOT_CHARGING }
    data class Cue(val kind: Kind, val value: Double? = null)

    /** The check-engine light as last read; persist it so the next drive compares with it. */
    var milOn = milWasOn
        private set
    private var startNs = Long.MIN_VALUE
    private var engineAnswered = false
    private var lastAnswerNs = 0L
    private var engineOffSinceAnswer = false
    private var lostSaid = false
    private var notConnectingSaid = false
    private var hotSinceNs = UNSET
    private var hotSaid = false
    private var lowSinceNs = UNSET
    private var lowSaid = false

    /**
     * [values]: the engine ECU's latest numbers by field name. [adapterVolts]: the adapter's own
     * voltage reading, used when the car doesn't report module voltage. [moving]: the phone's GPS says
     * it's driving.
     */
    fun tick(nowNs: Long, obdState: String, values: Map<String, Double>, adapterVolts: Double?, moving: Boolean): List<Cue> {
        if (startNs == Long.MIN_VALUE) startNs = nowNs
        val out = mutableListOf<Cue>()
        val answering = obdState == "polling" || obdState == "benchmarking"
        if (answering) {
            engineAnswered = true
            lastAnswerNs = nowNs
            engineOffSinceAnswer = false
            if (lostSaid) {
                lostSaid = false
                out += Cue(Kind.ADAPTER_BACK)
            }
        }
        if (obdState == "waiting_vehicle") engineOffSinceAnswer = true
        val linkDown = obdState in LINK_DOWN

        if (expectAdapter && !engineAnswered && !notConnectingSaid && linkDown && moving && nowNs - startNs >= NOT_CONNECTING_NS) {
            notConnectingSaid = true
            out += Cue(Kind.ADAPTER_NOT_CONNECTING)
        }
        if (engineAnswered && !lostSaid && !engineOffSinceAnswer && linkDown && moving && nowNs - lastAnswerNs >= LOST_NS) {
            lostSaid = true
            out += Cue(Kind.ADAPTER_LOST)
        }
        if (!answering) return out

        values["mil_on"]?.let { v ->
            val on = v >= 1.0
            if (on && !milOn) out += Cue(Kind.CHECK_ENGINE)
            milOn = on
        }
        values["coolant_temp"]?.let { c ->
            when {
                c >= HOT_C -> {
                    if (hotSinceNs == UNSET) hotSinceNs = nowNs
                    if (!hotSaid && nowNs - hotSinceNs >= HOT_NS) {
                        hotSaid = true
                        out += Cue(Kind.ENGINE_HOT, c)
                    }
                }
                c < COOL_C -> {
                    hotSinceNs = UNSET
                    hotSaid = false
                }
                else -> hotSinceNs = UNSET
            }
        }
        val volts = values["module_voltage"] ?: adapterVolts
        val rpm = values["rpm"]
        if (volts != null && rpm != null && rpm >= 500 && volts < LOW_VOLTS) {
            if (lowSinceNs == UNSET) lowSinceNs = nowNs
            if (!lowSaid && nowNs - lowSinceNs >= LOW_NS) {
                lowSaid = true
                out += Cue(Kind.NOT_CHARGING, volts)
            }
        } else lowSinceNs = UNSET
        return out
    }

    companion object {
        private const val UNSET = Long.MIN_VALUE
        private val LINK_DOWN = setOf("connecting", "disconnected", "initializing")
        private const val S = 1_000_000_000L
        const val NOT_CONNECTING_NS = 90 * S
        const val LOST_NS = 20 * S
        const val HOT_C = 113.0
        const val COOL_C = 105.0
        const val HOT_NS = 30 * S
        const val LOW_VOLTS = 12.0
        const val LOW_NS = 60 * S

        /** The adapter's "ATRV" answer ("14.2V") as volts. */
        fun parseVolts(rv: String): Double? = Regex("""(\d+(?:\.\d+)?)""").find(rv)?.value?.toDoubleOrNull()

        /** What to say for [cue], in a few words. */
        fun words(cue: Cue): String = when (cue.kind) {
            Kind.ADAPTER_NOT_CONNECTING -> "Fuelish can't reach the O B D adapter. This drive is recording from the phone only."
            Kind.ADAPTER_LOST -> "The O B D adapter disconnected. Still recording from the phone."
            Kind.ADAPTER_BACK -> "Adapter reconnected."
            Kind.CHECK_ENGINE -> "The check engine light just came on."
            Kind.ENGINE_HOT -> "The engine is running hot, ${Math.round((cue.value ?: HOT_C) * 9 / 5 + 32)} degrees."
            Kind.NOT_CHARGING -> "Battery voltage is low with the engine running, " +
                "${String.format(Locale.US, "%.1f", cue.value ?: LOW_VOLTS)} volts. The car may not be charging the battery."
        }
    }
}
