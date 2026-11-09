package app.fuelish.feedback

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin

/**
 * Speaks and chimes during a drive the way navigation prompts do: through the car's speakers when
 * the phone plays there, briefly lowering music or a podcast instead of pausing it. Sound only; the
 * phone stays on the mount.
 *
 * Lives for the process rather than one recording, so the summary said as a drive ends isn't cut off
 * when the recorder stops: [close] shuts text-to-speech down once it has finished talking.
 */
object DriveVoice {
    private const val TAG = "FuelishVoice"
    private val speech = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
    private val chimeAttrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    private var app: Context? = null
    private var tts: TextToSpeech? = null
    private var ready = false
    private val waiting = mutableListOf<String>()
    private var talking = 0
    private var closing = false
    private var serial = 0
    private var focus: AudioFocusRequest? = null
    /** An init result that arrived before [tts] was assigned (some engines answer inside the constructor). */
    private var earlyStatus: Int? = null

    /** Starts text-to-speech warming up, so the first thing said isn't late. */
    @Synchronized
    fun open(c: Context) {
        closing = false
        if (tts != null) return
        val a = c.applicationContext
        app = a
        ready = false
        earlyStatus = null
        tts = TextToSpeech(a) { status -> onInit(status) }
        earlyStatus?.let {
            earlyStatus = null
            onInit(it)
        }
    }

    @Synchronized
    private fun onInit(status: Int) {
        Log.i(TAG, "text-to-speech init: $status")
        val t = tts ?: run {
            earlyStatus = status
            return
        }
        if (status != TextToSpeech.SUCCESS) {
            Log.w(TAG, "text-to-speech unavailable ($status)")
            waiting.clear()
            shutdown()
            return
        }
        ready = true
        t.setAudioAttributes(speech)
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) = finished()
            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) = finished()
            override fun onError(utteranceId: String?, errorCode: Int) = finished()
        })
        val queued = waiting.toList()
        waiting.clear()
        queued.forEach(::speakNow)
        if (closing && talking == 0) shutdown()
    }

    @Synchronized
    fun say(c: Context, text: String) {
        Log.i(TAG, "say: $text")
        open(c)
        if (ready) speakNow(text) else waiting += text
    }

    private fun speakNow(text: String) {
        val t = tts ?: return
        talking++
        holdFocus()
        if (t.speak(text, TextToSpeech.QUEUE_ADD, null, "fuelish-${serial++}") != TextToSpeech.SUCCESS) finishedLocked()
    }

    @Synchronized
    private fun finished() = finishedLocked()

    private fun finishedLocked() {
        talking = (talking - 1).coerceAtLeast(0)
        if (talking > 0) return
        releaseFocus()
        if (closing) shutdown()
    }

    /** Done with speaking for now: shuts down once anything still queued has been said. */
    @Synchronized
    fun close() {
        closing = true
        if (tts == null || (ready && talking == 0)) shutdown()
    }

    private fun shutdown() {
        runCatching { tts?.shutdown() }
        tts = null
        ready = false
        talking = 0
        releaseFocus()
    }

    private fun holdFocus() {
        if (focus != null) return
        val am = app?.getSystemService(AudioManager::class.java) ?: return
        val f = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(speech).build()
        am.requestAudioFocus(f)
        focus = f
    }

    private fun releaseFocus() {
        val f = focus ?: return
        focus = null
        app?.getSystemService(AudioManager::class.java)?.abandonAudioFocusRequest(f)
    }

    /** A short rising two-note chime: recording has started. Plays on its own thread. */
    fun chime(c: Context) {
        val a = c.applicationContext
        Thread({
            runCatching {
                val pcm = notes(listOf(659.25, 987.77), noteMs = 140)
                val am = a.getSystemService(AudioManager::class.java)
                val f = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(chimeAttrs).build()
                am.requestAudioFocus(f)
                val track = AudioTrack.Builder()
                    .setAudioAttributes(chimeAttrs)
                    .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                    .setBufferSizeInBytes(pcm.size * 2)
                    .setTransferMode(AudioTrack.MODE_STATIC)
                    .build()
                try {
                    track.write(pcm, 0, pcm.size)
                    track.play()
                    Thread.sleep(pcm.size * 1000L / RATE + 150)
                } finally {
                    track.release()
                    am.abandonAudioFocusRequest(f)
                }
            }.onFailure { Log.w(TAG, "chime failed", it) }
        }, "fuelish-chime").apply { isDaemon = true }.start()
    }

    private const val RATE = 44_100

    /** Soft bell-like tones one after another: a quick attack, then an exponential fade. */
    private fun notes(freqs: List<Double>, noteMs: Int): ShortArray {
        val per = RATE * noteMs / 1000
        val tail = RATE * 250 / 1000 // the last note rings a little longer
        val out = ShortArray(per * (freqs.size - 1) + per + tail)
        freqs.forEachIndexed { i, f ->
            val len = if (i == freqs.lastIndex) per + tail else per * 2
            val start = per * i
            for (n in 0 until min(len, out.size - start)) {
                val t = n.toDouble() / RATE
                val env = min(1.0, n / (RATE * 0.005)) * Math.exp(-t * 9)
                val s = (sin(2 * PI * f * t) + 0.25 * sin(4 * PI * f * t)) * env * 0.35
                out[start + n] = (out[start + n] + (s * Short.MAX_VALUE).toInt()).coerceIn(-32768, 32767).toShort()
            }
        }
        return out
    }
}
