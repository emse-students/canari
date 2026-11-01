package fr.emse.canari

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import fr.emse.canari.call.IncomingRing
import fr.emse.canari.call.RingClosed
import fr.emse.canari.call.RingFacts
import fr.emse.canari.call.RingOutput
import fr.emse.canari.call.RingSequencer

/**
 * THE RING OF A CALL ARRIVING WHILE THE APP IS ON SCREEN, PLAYED NATIVELY (owner, 2026-11-01).
 *
 * The page rang with Web Audio, which a WebView plays on the MEDIA stream: silent with the media
 * volume down, loud in silent mode, one vibration and no more (the owner's first production call,
 * 2026-10-30). This plays the SAME rendered loop the `canari_calls_v2` channel rings with
 * (`res/raw/canari_ring.wav`) through a [MediaPlayer] on the RINGTONE stream
 * (`USAGE_NOTIFICATION_RINGTONE`), looped by the player itself, holding transient audio focus, and
 * honours the phone's state as the system ring does ([IncomingRing.plan]): silent rings nothing,
 * vibrate only vibrates, another call in progress only vibrates, and the vibration REPEATS until the
 * ring stops. It does NOT read the channel's importance: a user who turned the calls channel down
 * still hears the open app ring, as the system dialler's own in-call screen does.
 *
 * WHO RINGS WHICH CALL IS [rings] ([RingSequencer]), the one state the player and the native ring
 * share: one ring per call, and a call answered, ended or silenced never rings again. This object is
 * its Android half ([RingOutput]): the player, the vibrator, the audio focus, the screen held on,
 * and the native ring posted from a worker.
 *
 * - The page drives it through `window.canariCall.ringStart` / `ringStop` ([CallBridge.JsInterface]).
 * - Off screen ([MainActivity.isInForeground] false) a start is refused and the native ring posted.
 * - Leaving the screen ([leftScreen], `MainActivity.onStop`) hands the call to the native ring - or,
 *   when the SCREEN went off (the power button), silences it, as the system ring does.
 * - While it rings the activity keeps the screen on ([screenHold]): a screen that times out mid-ring
 *   would read as the power button.
 */
object CallRingPlayer {
    private const val TAG = "CallRingPlayer"

    private val main = Handler(Looper.getMainLooper())

    /** Set by [MainActivity] while it lives: keeps its window on while a ring plays. Main thread only. */
    @Volatile
    var screenHold: ((Boolean) -> Unit)? = null

    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var focus: AudioFocusRequest? = null

    private val ringAttributes: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    /** The process's one context: the player outlives any activity, and stops after one is gone. */
    private val context: Context
        get() = checkNotNull(CanariApplication.appContext()) {
            "CallRingPlayer used before CanariApplication.onCreate - no component of ours can be"
        }

    private val output = object : RingOutput {
        override fun play(ring: RingFacts) = playRing(ring)

        override fun silence(callId: String, reason: String) = silenceRing(callId, reason)

        override fun cancelNative(callId: String) =
            CanariFirebaseMessagingService.takeDownRingNotification(context, callId)

        override fun postNative(ring: RingFacts, why: String, silent: Boolean) {
            Log.i(TAG, "native ring of call=${short(ring.callId)} posted from a worker ($why, silent=$silent)")
            // OFF the main thread and OFF the sequencer's lock: the post builds the caller's name and
            // fetches the photo (Keystore, HTTP), and comes back through `rings.claimNative` itself.
            Thread({
                // A throw here would kill the process mid-ring. `claimNative` has already released
                // its claim; what is left is to say it, at the level of a defect.
                try {
                    CanariFirebaseMessagingService.showIncomingCallNotification(
                        context, ring.groupId, ring.callId, ring.callerId, ring.hasVideo, silent,
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "native ring of call=${short(ring.callId)} could not be posted: ${e.javaClass.simpleName}: ${e.message}", e)
                }
            }, "canari-ring-post").start()
        }

        override fun log(accuse: Boolean, message: String) {
            if (accuse) Log.w(TAG, message) else Log.i(TAG, message)
        }
    }

    /** Who rings each call, and which calls may not ring again. Shared with the FCM service. */
    val rings = RingSequencer({ MainActivity.isInForeground }, output)

    /** The call this phone rings for on screen right now, or null. Read by any thread. */
    val ringingCallId: String? get() = rings.ringingInApp

    /** The page asks for the in-app ring of [r] ([RingSequencer.startInApp]). */
    fun start(r: RingFacts) = rings.startInApp(r)

    /**
     * The app left the screen. [screenOff] (the display is not interactive: the power button)
     * silences the ring; otherwise the native ring takes the call over ([RingSequencer.leftScreen]).
     */
    fun leftScreen(screenOff: Boolean) = rings.leftScreen(screenOff)

    /** A new page loaded: the ring of the page before rings for a call no page shows any more. */
    fun pageLoaded() {
        val callId = ringingCallId ?: return
        rings.close(callId, RingClosed.ENDED, "a new page loaded - the ring of the previous page is gone")
    }

    private fun playRing(r: RingFacts) {
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val ringerMode = audio.ringerMode
        val audioMode = audio.mode
        val plan = IncomingRing.plan(ringerMode, r.appSounds, inAnotherCall = audioMode != AudioManager.MODE_NORMAL)
        Log.i(
            TAG,
            "start: call=${short(r.callId)} ringerMode=$ringerMode audioMode=$audioMode appSounds=${r.appSounds} -> sound=${plan.sound} vibrate=${plan.vibrate}",
        )
        if (plan.sound) startPlayer(audio)
        if (plan.vibrate) vibrate()
        holdScreen(true)
    }

    private fun silenceRing(callId: String, reason: String) {
        Log.i(TAG, "stop: call=${short(callId)} - $reason")
        player?.let {
            try {
                it.stop()
            } catch (e: IllegalStateException) {
                Log.w(TAG, "stop: the player was not playing: ${e.message}")
            }
            it.release()
        }
        player = null
        vibrator?.cancel()
        vibrator = null
        focus?.let { request ->
            val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val result = audio.abandonAudioFocusRequest(request)
            Log.i(TAG, "stop: audio focus abandoned (result=$result)")
        }
        focus = null
        holdScreen(false)
    }

    private fun holdScreen(on: Boolean) {
        main.post {
            val hold = screenHold
            if (hold == null) {
                Log.i(TAG, "screen hold $on: no activity to hold")
            } else {
                hold(on)
            }
        }
    }

    private fun startPlayer(audio: AudioManager) {
        // Transient focus, as the system's own ringtone takes it: music pauses while it rings.
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(ringAttributes)
            .build()
        val granted = audio.requestAudioFocus(request)
        if (granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            focus = request
            Log.i(TAG, "play: transient audio focus granted")
        } else {
            // Another app holds the focus (a call of its own): the ring still sounds, over it.
            Log.w(TAG, "play: transient audio focus NOT granted ($granted)")
        }
        val uri = Uri.parse("android.resource://${context.packageName}/${R.raw.canari_ring}")
        val mp = MediaPlayer()
        try {
            mp.setAudioAttributes(ringAttributes)
            mp.setDataSource(context, uri)
            mp.isLooping = true
            mp.prepare()
            mp.start()
            player = mp
            Log.i(TAG, "play: the Canari ring plays on the ringtone stream, looped")
        } catch (e: Exception) {
            // The tone is gone for this ring; the vibration and the screen still say a call is there.
            Log.e(TAG, "play: the ring could not be played: ${e.javaClass.simpleName}: ${e.message}")
            mp.release()
        }
    }

    private fun vibrate() {
        val v = if (Build.VERSION.SDK_INT >= 31) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        if (!v.hasVibrator()) {
            Log.i(TAG, "vibrate: this phone has no vibrator")
            return
        }
        val effect = VibrationEffect.createWaveform(IncomingRing.VIBRATION_PATTERN, IncomingRing.VIBRATION_REPEAT_FROM)
        if (Build.VERSION.SDK_INT >= 33) {
            v.vibrate(effect, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_RINGTONE))
        } else {
            @Suppress("DEPRECATION")
            v.vibrate(effect, ringAttributes)
        }
        vibrator = v
        Log.i(TAG, "vibrate: the ring's pattern repeats until the ring stops")
    }

    private fun short(callId: String?): String = callId?.take(8) ?: "-"
}
