package fr.emse.canari

import android.app.Activity
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

        /** The intent of the ring's full-screen intent: what the screen needs, and its two actions. */
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Over the lock screen, and lighting it: the two things the manifest also declares.
        setShowWhenLocked(true)
        setTurnScreenOn(true)

        callId = intent.getStringExtra(EXTRA_CALL_ID) ?: ""
        val title = intent.getStringExtra(EXTRA_TITLE) ?: ""
        val body = intent.getStringExtra(EXTRA_BODY) ?: ""
        val callerId = intent.getStringExtra(EXTRA_CALLER_ID) ?: ""
        val answer = pendingExtra(EXTRA_ANSWER)
        val decline = pendingExtra(EXTRA_DECLINE)
        if (callId.isEmpty() || answer == null || decline == null) {
            // Only the ring notification writes this intent; one missing a field is a defect there.
            Log.e(TAG, "unreadable call screen intent (call=${callId.isNotEmpty()} answer=${answer != null} decline=${decline != null}) - closed")
            finish()
            return
        }
        showing[callId] = WeakReference(this)
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
        // ago, so usually a file read.
        if (callerId.isNotEmpty()) {
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

    private fun sendAnswer(answer: PendingIntent) {
        try {
            answer.send()
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
    private fun pendingExtra(key: String): PendingIntent? =
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
