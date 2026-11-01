package fr.emse.canari

import android.content.Context
import android.media.AudioAttributes
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
 * THE RING OF A CALL ARRIVING WHILE THE APP IS OPEN, PLAYED NATIVELY (owner, 2026-11-01).
 *
 * The page rang with Web Audio, which a WebView plays on the MEDIA stream: silent with the media
 * volume down, loud in silent mode, one vibration and no more (the owner's first production call,
 * 2026-10-30). This plays the SAME rendered loop the `canari_calls_v2` channel rings with
 * (`res/raw/canari_ring.wav`) through a [MediaPlayer] on the RINGTONE stream
 * (`USAGE_NOTIFICATION_RINGTONE`), looped by the player itself, and honours the ringer mode as the
 * system ring does ([IncomingRing.plan]): silent rings nothing, vibrate only vibrates, and the
 * vibration REPEATS until the ring stops.
 *
 * The page drives it through `window.canariCall.ringStart` / `ringStop` ([CallBridge.JsInterface]),
 * from the same state that shows the incoming screen. Its state - [ringingCallId] - is a fact of
 * this process, so a message notification posted while it rings is posted silent
 * ([fr.emse.canari.push.CallSoundHold]), and it dies with the process.
 *
 * All methods run on the main thread (the bridge posts there), so the player is never touched by
 * two threads.
 */
object CallRingPlayer {
    private const val TAG = "CallRingPlayer"

    /** The call this phone rings for in the app right now, or null. Read by any thread. */
    @Volatile
    var ringingCallId: String? = null
        private set

    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null

    /**
     * Starts ringing for [callId]. A ring already up for ANOTHER call is stopped first (the page
     * shows one incoming call at a time); a second start for the same call is a no-op, logged.
     *
     * @param appSounds the app's own "sounds" setting: off, the phone only vibrates.
     */
    fun start(context: Context, callId: String, appSounds: Boolean) {
        if (ringingCallId == callId) {
            Log.i(TAG, "start: call=${short(callId)} already rings - nothing to do")
            return
        }
        ringingCallId?.let { stop(it, "another call rings") }
        val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val mode = audio.ringerMode
        val plan = IncomingRing.plan(mode, appSounds)
        Log.i(TAG, "start: call=${short(callId)} ringerMode=$mode appSounds=$appSounds -> sound=${plan.sound} vibrate=${plan.vibrate}")
        ringingCallId = callId
        if (plan.sound) play(context)
        if (plan.vibrate) vibrate(context)
    }

    /** Stops the ring of [callId]. A stop for a call that does not ring here is logged and ignored. */
    fun stop(callId: String, reason: String) {
        if (ringingCallId != callId) {
            Log.i(TAG, "stop: call=${short(callId)} does not ring here (ringing=${short(ringingCallId)}) - $reason")
            return
        }
        Log.i(TAG, "stop: call=${short(callId)} - $reason")
        ringingCallId = null
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
    }

    private fun play(context: Context) {
        val uri = Uri.parse("android.resource://${context.packageName}/${R.raw.canari_ring}")
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val mp = MediaPlayer()
        try {
            mp.setAudioAttributes(attrs)
            mp.setDataSource(context, uri)
            mp.isLooping = true
            mp.prepare()
            mp.start()
            player = mp
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
            v.vibrate(
                effect,
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build(),
            )
        }
        vibrator = v
    }

    private fun short(callId: String?): String = callId?.take(8) ?: "-"
}
