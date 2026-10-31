package fr.emse.canari

import android.app.Activity
import android.app.ActivityOptions
import android.app.KeyguardManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.lang.ref.WeakReference

/**
 * THE INCOMING-CALL SCREEN OF A CLOSED OR LOCKED PHONE (the native ring, owner 2026-10-30): the
 * caller's photo and name over the lock screen, with Answer and Decline - what WhatsApp shows.
 *
 * It is the ring notification's FULL-SCREEN INTENT, and that is why it exists at all: Android LAUNCHES
 * a full-screen intent by itself on a locked or idle phone, so the intent must open a screen that
 * asks, never the answer. (It used to be the answer deep link, which would have answered every call
 * that rang on a locked phone with nobody touching it.)
 *
 * - **Answer** asks the keyguard to go first (`requestDismissKeyguard`: the PIN, the pattern or the
 *   face), then hands over to the same answer [PendingIntent] the notification's Answer button uses
 *   - the `acceptCall` deep link the web view drains once the app's own PIN is entered. A dismissal
 *   the user cancels leaves the screen up, still ringing.
 * - **Decline** stops the ring on this device, as the notification's Decline does (local only).
 * - The screen goes with its ring: [finishFor] is called by
 *   `CanariFirebaseMessagingService.cancelIncomingCallNotification`, whoever ended the ring (the
 *   caller cancelled, a sibling answered, the 60 s window, a decline).
 *
 * The ringtone is the ring notification's own (the calls channel, `FLAG_INSISTENT`): this screen
 * plays nothing itself.
 */
class IncomingCallActivity : Activity() {
    companion object {
        private const val TAG = "IncomingCallActivity"
        private const val EXTRA_CALL_ID = "callId"
        private const val EXTRA_CALLER_ID = "callerId"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_BODY = "body"
        private const val EXTRA_ANSWER = "answer"
        private const val EXTRA_DECLINE = "decline"

        /** The screen showing each ringing call, so its ring's end can close it. Main thread only. */
        private val showing = mutableMapOf<String, WeakReference<IncomingCallActivity>>()

        /**
         * The intent of the ring's full-screen intent: what the screen needs, and its two actions.
         * [callerId] is the caller whose photo to show - empty for a caller this phone never named.
         */
        fun intentFor(
            context: Context,
            callId: String,
            callerId: String,
            title: String,
            body: String,
            answer: PendingIntent,
            decline: PendingIntent,
        ): Intent = Intent(context, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION
            putExtra(EXTRA_CALL_ID, callId)
            putExtra(EXTRA_CALLER_ID, callerId)
            putExtra(EXTRA_TITLE, title)
            putExtra(EXTRA_BODY, body)
            putExtra(EXTRA_ANSWER, answer)
            putExtra(EXTRA_DECLINE, decline)
        }

        /** Closes the screen of [callId], if one shows; a no-op otherwise. Any thread. */
        fun finishFor(callId: String, why: String) {
            Handler(Looper.getMainLooper()).post {
                val activity = showing.remove(callId)?.get() ?: return@post
                Log.i(TAG, "closing the call screen of call=${callId.take(8)}: $why")
                activity.finish()
            }
        }
    }

    private var callId: String = ""

    private val main = Handler(Looper.getMainLooper())

    /** The screen's own bound: never up longer than a ring can last, whatever reached it or not. */
    private val ringWindowOver = Runnable {
        Log.i(TAG, "call screen of call=${callId.take(8)} reached the ring window - closed")
        finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Over the lock screen, and lighting it: the two things the manifest also declares.
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        show(intent)
    }

    /**
     * A SECOND CALL while this screen shows (`singleTop` delivers its full-screen intent here): the
     * screen becomes that call's. The first call's ring is still the notification's to end; its
     * screen entry is dropped, so its `finishFor` no longer closes the screen of the call now shown.
     *
     * A second call that NO LONGER RINGS by the time it arrives replaces nothing: the first call's
     * screen stays while that call still rings, and closes only when it does not either.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val previous = callId
        val next = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
        if (next.isNotEmpty() && !CanariFirebaseMessagingService.isRinging(next)) {
            if (previous.isNotEmpty() && CanariFirebaseMessagingService.isRinging(previous)) {
                Log.i(TAG, "call=${next.take(8)} no longer rings - the screen of call=${previous.take(8)} stays")
            } else {
                Log.i(TAG, "call=${next.take(8)} no longer rings, nor call=${previous.take(8)} - closed")
                finish()
            }
            return
        }
        setIntent(intent)
        if (showing[previous]?.get() === this) showing.remove(previous)
        main.removeCallbacks(ringWindowOver)
        Log.i(TAG, "a new call screen replaces call=${previous.take(8)}")
        show(intent)
    }

    /** Draws the call of [intent], or closes at once when that call no longer rings. */
    private fun show(intent: Intent) {
        callId = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
        val title = intent.getStringExtra(EXTRA_TITLE) ?: ""
        val body = intent.getStringExtra(EXTRA_BODY) ?: ""
        val callerId = intent.getStringExtra(EXTRA_CALLER_ID) ?: ""
        val answer = pendingExtra(intent, EXTRA_ANSWER)
        val decline = pendingExtra(intent, EXTRA_DECLINE)
        if (callId.isEmpty() || answer == null || decline == null) {
            // Only the ring notification writes this intent; one missing a field is a defect there.
            Log.e(TAG, "unreadable call screen intent (call=${callId.isNotEmpty()} answer=${answer != null} decline=${decline != null}) - closed")
            finish()
            return
        }
        // THE SCREEN NEVER OUTLIVES ITS RING. The ring may have ended between its notify and this
        // launch (the caller cancelled, the 60 s ran out): `finishFor` found no screen to close
        // then, so the screen asks for itself - on the main thread, the one `finishFor` runs on.
        if (!CanariFirebaseMessagingService.isRinging(callId)) {
            Log.i(TAG, "call=${callId.take(8)} no longer rings - its screen is not shown")
            finish()
            return
        }
        showing[callId] = WeakReference(this)
        main.postDelayed(ringWindowOver, CanariFirebaseMessagingService.CALL_RING_TIMEOUT_MS)
        Log.i(TAG, "call screen shown for call=${callId.take(8)} locked=${keyguard().isKeyguardLocked}")

        val photo = ImageView(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(120), dp(120)).apply { bottomMargin = dp(24) }
            scaleType = ImageView.ScaleType.CENTER_CROP
            setImageResource(R.mipmap.ic_launcher)
        }
        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setBackgroundColor(Color.rgb(16, 18, 22))
                setPadding(dp(24), dp(48), dp(24), dp(48))
                addView(photo)
                addView(label(title, 28f, Typeface.BOLD))
                addView(label(body, 18f, Typeface.NORMAL))
                addView(
                    LinearLayout(this@IncomingCallActivity).apply {
                        orientation = LinearLayout.HORIZONTAL
                        gravity = Gravity.CENTER
                        layoutParams = LinearLayout.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                        ).apply { topMargin = dp(64) }
                        addView(action(R.string.notif_action_decline_call, Color.rgb(220, 53, 69)) { onDecline(decline) })
                        addView(action(R.string.notif_action_answer_call, Color.rgb(40, 167, 69)) { onAnswer(answer) })
                    },
                )
            },
        )

        // The photo off the main thread: the same cached fetch the ring notification used a moment
        // ago, so usually a file read. An empty callerId is the ring's word for a caller this phone
        // never named (decision 6): no face either, the launcher icon stays.
        if (callerId.isEmpty()) {
            Log.d(TAG, "caller not named on this phone - no photo on the call screen")
        } else {
            val app = applicationContext
            Thread({
                val bitmap = CanariFirebaseMessagingService.callAvatar(app, callerId)
                runOnUiThread {
                    if (bitmap != null && !isFinishing) photo.setImageBitmap(bitmap)
                    Log.d(TAG, "caller photo on the call screen: ${bitmap != null}")
                }
            }, "canari-ring-avatar").start()
        }
    }

    override fun onDestroy() {
        main.removeCallbacks(ringWindowOver)
        if (showing[callId]?.get() === this) showing.remove(callId)
        super.onDestroy()
    }

    /** Unlock first (the system's own prompt), then the answer the notification's button sends. */
    private fun onAnswer(answer: PendingIntent) {
        Log.i(TAG, "answer tapped on the call screen of call=${callId.take(8)}")
        val keyguard = keyguard()
        if (!keyguard.isKeyguardLocked) {
            sendAnswer(answer)
            return
        }
        keyguard.requestDismissKeyguard(
            this,
            object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = sendAnswer(answer)
                override fun onDismissCancelled() {
                    Log.i(TAG, "unlock cancelled - the call screen stays, still ringing")
                }
                override fun onDismissError() {
                    Log.e(TAG, "the keyguard refused to dismiss - the call screen stays")
                }
            },
        )
    }

    /**
     * THE ANSWER MAY START THE APP'S ACTIVITY: from API 34 a PendingIntent's sender must opt in to
     * lending its background-activity-start privilege, or the deep link is blocked. This screen is
     * visible when the user taps, so API 36+ asks only for that (`ALLOW_IF_VISIBLE`); API 34-35 have
     * no such mode and take `ALLOWED`. Below 34 no opt-in exists or is needed.
     */
    private fun sendAnswer(answer: PendingIntent) {
        try {
            val sdk = android.os.Build.VERSION.SDK_INT
            if (sdk >= 34) {
                val mode = if (sdk >= 36) {
                    ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_IF_VISIBLE
                } else {
                    @Suppress("DEPRECATION")
                    ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                }
                val options = ActivityOptions.makeBasic().setPendingIntentBackgroundActivityStartMode(mode)
                Log.i(TAG, "answer sent with background-start mode=${if (sdk >= 36) "ALLOW_IF_VISIBLE" else "ALLOWED"} sdk=$sdk")
                answer.send(options.toBundle())
            } else {
                Log.i(TAG, "answer sent without a background-start mode sdk=$sdk")
                answer.send()
            }
            Log.i(TAG, "answer handed to the app for call=${callId.take(8)}")
        } catch (e: PendingIntent.CanceledException) {
            // The ring's intents were cancelled with it: the call is already over.
            Log.w(TAG, "answer not delivered - the ring already ended: ${e.message}")
        }
        finish()
    }

    private fun onDecline(decline: PendingIntent) {
        Log.i(TAG, "decline tapped on the call screen of call=${callId.take(8)}")
        try {
            decline.send()
        } catch (e: PendingIntent.CanceledException) {
            Log.w(TAG, "decline not delivered - the ring already ended: ${e.message}")
        }
        finish()
    }

    private fun keyguard(): KeyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager

    @Suppress("DEPRECATION")
    private fun pendingExtra(intent: Intent, key: String): PendingIntent? =
        if (android.os.Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(key, PendingIntent::class.java)
        else intent.getParcelableExtra(key)

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private fun label(text: String, sp: Float, style: Int) = TextView(this).apply {
        this.text = text
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        setTypeface(typeface, style)
        gravity = Gravity.CENTER
    }

    private fun action(textRes: Int, color: Int, onTap: () -> Unit) = Button(this).apply {
        // The language chosen in the app, not the phone's - the rule every native string follows.
        text = appLocaleContext(this@IncomingCallActivity).getString(textRes)
        setTextColor(Color.WHITE)
        setBackgroundColor(color)
        layoutParams = LinearLayout.LayoutParams(0, dp(64), 1f).apply { setMargins(dp(12), 0, dp(12), 0) }
        setOnClickListener { onTap() }
    }
}
