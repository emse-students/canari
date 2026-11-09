package fr.emse.canari

import android.animation.Animator
import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.app.Activity
import android.app.ActivityOptions
import android.app.KeyguardManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.RenderEffect
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.WindowInsets
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.lang.ref.WeakReference

/**
 * The caller's photo for the call screen ([CanariFirebaseMessagingService.callScreenPhoto]):
 * [uncropped] says whether [bitmap] is the whole original (backdrop and face) or only the
 * circle-cropped notification icon (the face alone).
 */
class CallScreenPhoto(val bitmap: Bitmap, val uncropped: Boolean)

/**
 * THE INCOMING-CALL SCREEN OF A CLOSED OR LOCKED PHONE (the native ring, owner 2026-10-30): the
 * caller's photo and name over the lock screen, with Answer and Decline - what WhatsApp shows. Drawn
 * in Canari's look, the same screen as the in-app ring (owner 2026-11-01, see [drawScreen]).
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
        private const val EXTRA_HAS_VIDEO = "hasVideo"

        /** One breath of the halo out of the photo, and the second halo's offset: the in-app ring's. */
        private const val HALO_MS = 2400L
        private const val HALO_SCALE = 1.45f
        private const val EXTRA_ANSWER = "answer"
        private const val EXTRA_DECLINE = "decline"

        /** The screen showing each ringing call, so its ring's end can close it. Main thread only. */
        private val showing = mutableMapOf<String, WeakReference<IncomingCallActivity>>()

        /**
         * The intent of the ring's full-screen intent: what the screen needs, and its two actions.
         * [callerId] is the caller whose photo to show - empty for a caller this phone never named.
         * [hasVideo] picks the subtitle ("Appel vidéo" or "Appel audio") and Answer's glyph.
         */
        fun intentFor(
            context: Context,
            callId: String,
            callerId: String,
            title: String,
            hasVideo: Boolean,
            answer: PendingIntent,
            decline: PendingIntent,
        ): Intent = Intent(context, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION
            putExtra(EXTRA_CALL_ID, callId)
            putExtra(EXTRA_CALLER_ID, callerId)
            putExtra(EXTRA_TITLE, title)
            putExtra(EXTRA_HAS_VIDEO, hasVideo)
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
        val hasVideo = intent.getBooleanExtra(EXTRA_HAS_VIDEO, false)
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
        Log.i(TAG, "call screen shown for call=${callId.take(8)} locked=${keyguard().isKeyguardLocked} video=$hasVideo")

        val screen = drawScreen(title, hasVideo, named = callerId.isNotEmpty(), answer = answer, decline = decline)

        // The photo off the main thread: the same cached fetch the ring notification used a moment
        // ago, so usually a file read. An empty callerId is the ring's word for a caller this phone
        // never named (decision 6): no face either, the Canari mark stays.
        if (callerId.isEmpty()) {
            Log.d(TAG, "caller not named on this phone - no photo on the call screen")
        } else {
            val app = applicationContext
            // The ORIGINAL photo, sampled to the screen's short edge: the backdrop is full-bleed.
            val target = minOf(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels)
            Thread({
                val photo = CanariFirebaseMessagingService.callScreenPhoto(app, callerId, target)
                runOnUiThread {
                    if (photo != null && !isFinishing) screen.showPhoto(photo)
                    Log.d(TAG, "caller photo on the call screen: ${photo != null} uncropped=${photo?.uncropped}")
                }
            }, "canari-ring-avatar").start()
        }
    }

    /** The views a late photo lands in: the face itself, and the blurred backdrop behind the screen. */
    private class Screen(val photo: ImageView, val initials: TextView, val backdrop: ImageView) {
        fun showPhoto(source: CallScreenPhoto) {
            // The face is cropped round IN DRAWING (its frame clips to its oval, CENTER_CROP fills it).
            photo.setImageBitmap(source.bitmap)
            photo.visibility = View.VISIBLE
            initials.visibility = View.GONE
            // The backdrop wants the whole, UNCROPPED photo - the notification icon would blur into a
            // disc with transparent corners - and RenderEffect (API 31). Otherwise the gradient alone.
            if (source.uncropped && android.os.Build.VERSION.SDK_INT >= 31) {
                backdrop.setImageBitmap(source.bitmap)
                backdrop.visibility = View.VISIBLE
            }
        }
    }

    /**
     * THE RING, IN CANARI'S LOOK (owner, 2026-11-01: *"quelque chose de joli avec ecrit Appel video ou
     * Appel audio, la photo et le nom"*) - the same screen as the in-app ring (`CallOverlay.svelte`),
     * built from the same tokens (`res/values/colors.xml` names each one's `app.css` twin):
     * - Canari's night gradient (ink to scrim), the caller's photo blurred over it once it arrives,
     *   and the brand's yellow glow behind the face;
     * - the photo, large and round in a yellow ring, two halos breathing out of it - still when the
     *   phone's animations are off (the system's "remove animations", Android's reduced motion);
     * - the name, then WHICH call rings with its glyph ("Appel audio" / "Appel video");
     * - Decline (red, left) and Answer (green, right; a camera for a video call), round, labelled
     *   under, at the bottom under the thumb - the order of the CallStyle ring and of CallKit.
     */
    private fun drawScreen(
        title: String,
        hasVideo: Boolean,
        named: Boolean,
        answer: PendingIntent,
        decline: PendingIntent,
    ): Screen {
        stopHalos()
        val res = appLocaleContext(this)
        val ink = getColor(R.color.call_screen_top)
        val scrim = getColor(R.color.call_screen_bottom)
        val yellow = getColor(R.color.call_halo)
        val wrap = ViewGroup.LayoutParams.WRAP_CONTENT
        val match = ViewGroup.LayoutParams.MATCH_PARENT

        val backdrop = ImageView(this).apply {
            layoutParams = FrameLayout.LayoutParams(match, match)
            scaleType = ImageView.ScaleType.CENTER_CROP
            alpha = 0.6f
            scaleX = 1.3f
            scaleY = 1.3f
            visibility = View.GONE
            if (android.os.Build.VERSION.SDK_INT >= 31) {
                setRenderEffect(RenderEffect.createBlurEffect(dp(48).toFloat(), dp(48).toFloat(), Shader.TileMode.CLAMP))
            }
        }
        val veil = View(this).apply {
            layoutParams = FrameLayout.LayoutParams(match, match)
            background = GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                intArrayOf(withAlpha(ink, 0.4f), withAlpha(scrim, 0.55f), withAlpha(scrim, 0.9f)),
            )
        }

        // The face: 144dp in a 216dp frame, so the halos (x1.45) and the glow breathe inside it.
        val face = dp(144)
        val frame = FrameLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(dp(216), dp(216))
            clipChildren = false
        }
        frame.addView(View(this).apply {
            layoutParams = FrameLayout.LayoutParams(dp(320), dp(320), Gravity.CENTER)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                gradientType = GradientDrawable.RADIAL_GRADIENT
                gradientRadius = dp(160).toFloat()
                colors = intArrayOf(withAlpha(yellow, 0.22f), withAlpha(yellow, 0f))
            }
        })
        for ((strength, delay) in listOf(0.3f to 0L, 0.2f to HALO_MS / 2)) {
            val halo = View(this).apply {
                layoutParams = FrameLayout.LayoutParams(face, face, Gravity.CENTER)
                background = oval(withAlpha(yellow, strength))
            }
            frame.addView(halo)
            breathe(halo, delay)
        }
        val photo = ImageView(this).apply {
            layoutParams = FrameLayout.LayoutParams(match, match)
            scaleType = ImageView.ScaleType.CENTER_CROP
            visibility = View.GONE
        }
        val initials = TextView(this).apply {
            layoutParams = FrameLayout.LayoutParams(match, match)
            gravity = Gravity.CENTER
            setTextColor(getColor(R.color.call_on_screen))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 48f)
            setTypeface(typeface, Typeface.BOLD)
            text = initialsOf(title)
        }
        // A caller this phone never named has no initials either: the Canari mark stands in.
        if (!named) {
            photo.setImageResource(R.mipmap.ic_launcher)
            photo.visibility = View.VISIBLE
            initials.visibility = View.GONE
        }
        // The yellow ring, and inside it the round face (clipped by its own oval, so the square
        // photo never covers the ring's corners).
        frame.addView(FrameLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(face, face, Gravity.CENTER)
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(withAlpha(yellow, 0.6f))
            }
            outlineProvider = ViewOutlineProvider.BACKGROUND
            elevation = dp(12).toFloat()
            addView(FrameLayout(this@IncomingCallActivity).apply {
                layoutParams = FrameLayout.LayoutParams(match, match).apply { setMargins(dp(4), dp(4), dp(4), dp(4)) }
                background = oval(ink)
                outlineProvider = ViewOutlineProvider.BACKGROUND
                clipToOutline = true
                addView(initials)
                addView(photo)
            })
        })

        val name = TextView(this).apply {
            layoutParams = LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(8) }
            text = title
            setTextColor(getColor(R.color.call_on_screen))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 32f)
            setTypeface(typeface, Typeface.BOLD)
            gravity = Gravity.CENTER
            maxLines = 2
            ellipsize = TextUtils.TruncateAt.END
        }
        val kind = LinearLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(wrap, wrap).apply { topMargin = dp(12) }
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(6), dp(14), dp(6))
            background = GradientDrawable().apply {
                cornerRadius = dp(999).toFloat()
                setColor(getColor(R.color.call_pill_fill))
                setStroke(dp(1), getColor(R.color.call_pill_stroke))
            }
            addView(ImageView(this@IncomingCallActivity).apply {
                layoutParams = LinearLayout.LayoutParams(dp(16), dp(16)).apply { marginEnd = dp(8) }
                setImageResource(if (hasVideo) R.drawable.ic_call_answer_video else R.drawable.ic_call_answer)
                imageAlpha = 230
            })
            addView(TextView(this@IncomingCallActivity).apply {
                text = res.getString(if (hasVideo) R.string.call_screen_kind_video else R.string.call_screen_kind_audio)
                setTextColor(getColor(R.color.call_on_screen_secondary))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                setTypeface(typeface, Typeface.BOLD)
            })
        }

        val actions = LinearLayout(this).apply {
            layoutParams = LinearLayout.LayoutParams(match, wrap)
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(dp(16), 0, dp(16), 0)
            addView(action(res.getString(R.string.notif_action_decline_call), R.drawable.ic_call_decline, getColor(R.color.call_decline)) { onDecline(decline) })
            addView(
                action(
                    res.getString(R.string.notif_action_answer_call),
                    if (hasVideo) R.drawable.ic_call_answer_video else R.drawable.ic_call_answer,
                    getColor(R.color.call_accept),
                ) { onAnswer(answer) },
            )
        }

        val column = LinearLayout(this).apply {
            layoutParams = FrameLayout.LayoutParams(match, match)
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            clipChildren = false
            clipToPadding = false
            addView(View(this@IncomingCallActivity).apply { layoutParams = LinearLayout.LayoutParams(match, 0, 1f) })
            addView(frame)
            addView(name)
            addView(kind)
            addView(View(this@IncomingCallActivity).apply { layoutParams = LinearLayout.LayoutParams(match, 0, 1.4f) })
            addView(actions)
        }
        val root = FrameLayout(this).apply {
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(ink, scrim))
            clipChildren = false
            addView(backdrop)
            addView(veil)
            addView(column)
        }
        // Under the status and navigation bars, never behind them: the buttons stay above the
        // gesture bar, the photo below the clock.
        root.setOnApplyWindowInsetsListener { _, insets ->
            val (top, bottom) = if (android.os.Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars())
                bars.top to bars.bottom
            } else {
                @Suppress("DEPRECATION")
                insets.systemWindowInsetTop to insets.systemWindowInsetBottom
            }
            column.setPadding(dp(24), top + dp(24), dp(24), bottom + dp(56))
            insets
        }
        setContentView(root)
        return Screen(photo, initials, backdrop)
    }

    /** The halos' breath; none when the phone's animations are off (the user asked for stillness). */
    private val halos = mutableListOf<Animator>()

    private fun breathe(halo: View, delay: Long) {
        if (!ValueAnimator.areAnimatorsEnabled()) {
            Log.d(TAG, "animations are off on this phone - the call screen's halo stays still")
            return
        }
        halos += ObjectAnimator.ofPropertyValuesHolder(
            halo,
            PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, HALO_SCALE),
            PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, HALO_SCALE),
            PropertyValuesHolder.ofFloat(View.ALPHA, 0.9f, 0f),
        ).apply {
            duration = HALO_MS
            startDelay = delay
            repeatCount = ValueAnimator.INFINITE
            interpolator = DecelerateInterpolator()
            start()
        }
    }

    private fun stopHalos() {
        halos.forEach { it.cancel() }
        halos.clear()
    }

    override fun onDestroy() {
        stopHalos()
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

    /** [color] with [alpha] (0..1) in place of its own. */
    private fun withAlpha(color: Int, alpha: Float): Int =
        (color and 0x00FFFFFF) or ((alpha * 255).toInt().coerceIn(0, 255) shl 24)

    private fun oval(color: Int) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(color)
    }

    /** The caller's initials, as the app's avatar draws them: the first letter of two words. */
    private fun initialsOf(name: String): String =
        name.split(Regex("[\\s._-]+"))
            .mapNotNull { word -> word.firstOrNull { it.isLetterOrDigit() } }
            .take(2)
            .joinToString("")
            .uppercase()

    /**
     * One round action - a 72dp disc of [color] with its glyph, a ripple, and its [label] UNDER it
     * (the label is also what a screen reader says). The label is in the language chosen in the app,
     * not the phone's - the rule every native string follows.
     */
    private fun action(label: String, icon: Int, color: Int, onTap: () -> Unit) = LinearLayout(this).apply {
        layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER_HORIZONTAL
        clipChildren = false
        clipToPadding = false
        addView(ImageButton(this@IncomingCallActivity).apply {
            layoutParams = LinearLayout.LayoutParams(dp(72), dp(72))
            background = RippleDrawable(ColorStateList.valueOf(getColor(R.color.call_ripple)), oval(color), null)
            setImageResource(icon)
            setPadding(dp(20), dp(20), dp(20), dp(20))
            scaleType = ImageView.ScaleType.FIT_CENTER
            outlineProvider = ViewOutlineProvider.BACKGROUND
            elevation = dp(8).toFloat()
            contentDescription = label
            setOnClickListener { onTap() }
        })
        addView(TextView(this@IncomingCallActivity).apply {
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = dp(10) }
            text = label
            setTextColor(getColor(R.color.call_on_screen_label))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        })
    }
}
