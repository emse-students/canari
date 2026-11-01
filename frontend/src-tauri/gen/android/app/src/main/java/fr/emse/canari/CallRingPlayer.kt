package fr.emse.canari

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import fr.emse.canari.call.IncomingRing

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
 * ring stops.
 *
 * IT RINGS ONLY WHILE THE APP IS ON SCREEN ([MainActivity.isInForeground]). Off screen the ring is
 * the native CallStyle ring ([CanariFirebaseMessagingService.showIncomingCallNotification]) - ONE
 * ring, never both:
 * - a start that arrives while the app is not in front (the page's ask raced `onStop`) is REFUSED,
 *   and the native ring is posted from the facts the page gave;
 * - leaving the screen ([handOverOffScreen], `MainActivity.onStop`) stops the player and posts the
 *   native ring, which carries Answer, Decline and the full-screen screen the open app had;
 * - coming back, the page asks again: the native ring of that call is cancelled and the player rings.
 *
 * The page drives it through `window.canariCall.ringStart` / `ringStop` ([CallBridge.JsInterface]).
 * Every end of the native ring ([CanariFirebaseMessagingService.cancelIncomingCallNotification]:
 * `call_ring_end`, a decline, the timeout) stops the player of that call too ([stopIfRinging]).
 * Its state - [ringingCallId] - is a fact of this process, so a message notification posted while it
 * rings is posted silent ([fr.emse.canari.push.CallSoundHold]), and it dies with the process.
 *
 * Every method is `@Synchronized`: the bridge posts to the main thread, the FCM service's cancel runs
 * on its own.
 */
object CallRingPlayer {
    private const val TAG = "CallRingPlayer"

    /** What the page knows of the ringing call - what the native ring needs to be posted. */
    data class Ring(
        val callId: String,
        val groupId: String,
        val callerId: String,
        val hasVideo: Boolean,
        val appSounds: Boolean,
    )

    /** The call this phone rings for on screen right now, or null. Read by any thread. */
    @Volatile
    var ringingCallId: String? = null
        private set

    private var ring: Ring? = null
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var focus: AudioFocusRequest? = null

    private val ringAttributes: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    /**
     * Starts ringing [r] on screen. A second start for the same call is a no-op, logged; a ring of
     * ANOTHER call is stopped first (the page shows one incoming call at a time). Refused off screen:
     * the native ring is posted instead.
     */
    @Synchronized
    fun start(context: Context, r: Ring) {
        if (!MainActivity.isInForeground) {
            Log.w(TAG, "start REFUSED: call=${short(r.callId)} - the app is not on screen; the native ring rings it instead")
            postNativeRing(context, r, "the page asked while off screen")
            return
        }
        if (ringingCallId == r.callId) {
            Log.i(TAG, "start: call=${short(r.callId)} already rings - nothing to do")
            return
        }
        ringingCallId?.let { stopLocked(it, "another call rings") }
        // The page rings it now: a native ring of the same call (handed over when the app left the
        // screen, or posted by a `call_ring` that raced the page) would ring it twice.
        CanariFirebaseMessagingService.cancelIncomingCallNotification(context, r.callId)
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val ringerMode = audio.ringerMode
        val audioMode = audio.mode
        val plan = IncomingRing.plan(ringerMode, r.appSounds, inAnotherCall = audioMode != AudioManager.MODE_NORMAL)
        Log.i(
            TAG,
            "start: call=${short(r.callId)} ringerMode=$ringerMode audioMode=$audioMode appSounds=${r.appSounds} -> sound=${plan.sound} vibrate=${plan.vibrate}",
        )
        ring = r
        ringingCallId = r.callId
        if (plan.sound) play(context, audio)
        if (plan.vibrate) vibrate(context)
    }

    /** Stops the ring of [callId]. A stop for a call that does not ring here is logged and ignored. */
    @Synchronized
    fun stop(context: Context, callId: String, reason: String) {
        if (ringingCallId != callId) {
            Log.i(TAG, "stop: call=${short(callId)} does not ring here (ringing=${short(ringingCallId)}) - $reason")
            return
        }
        stopLocked(callId, reason, context)
    }

    /**
     * The native ring of [callId] ended ([CanariFirebaseMessagingService.cancelIncomingCallNotification]):
     * its player stops too. Silent when this call does not ring here - every cancel calls it.
     */
    @Synchronized
    fun stopIfRinging(context: Context, callId: String, reason: String) {
        if (ringingCallId == callId) stopLocked(callId, reason, context)
    }

    /**
     * The app left the screen (`MainActivity.onStop`): the player stops and the call rings on as the
     * native CallStyle ring - Answer, Decline, the lock-screen screen - until it is answered, declined
     * or ended. Without it a Home press during the ring left a call nobody heard: Android's WebView
     * never reports `hidden`, so the page's own deferred notice never posts there.
     */
    @Synchronized
    fun handOverOffScreen(context: Context) {
        val r = ring ?: return
        stopLocked(r.callId, "the app left the screen - handed over to the native ring", context)
        postNativeRing(context, r, "the app left the screen")
    }

    private fun postNativeRing(context: Context, r: Ring, why: String) {
        Log.i(TAG, "native ring posted for call=${short(r.callId)} ($why)")
        CanariFirebaseMessagingService.showIncomingCallNotification(
            context.applicationContext, r.groupId, r.callId, r.callerId, r.hasVideo,
        )
    }

    private fun stopLocked(callId: String, reason: String, context: Context? = null) {
        Log.i(TAG, "stop: call=${short(callId)} - $reason")
        ringingCallId = null
        ring = null
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
            val audio = context?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
            if (audio == null) {
                Log.w(TAG, "stop: no AudioManager to abandon the ring's audio focus")
            } else {
                val result = audio.abandonAudioFocusRequest(request)
                Log.i(TAG, "stop: audio focus abandoned (result=$result)")
            }
        }
        focus = null
    }

    private fun play(context: Context, audio: AudioManager) {
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

    private fun vibrate(context: Context) {
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
