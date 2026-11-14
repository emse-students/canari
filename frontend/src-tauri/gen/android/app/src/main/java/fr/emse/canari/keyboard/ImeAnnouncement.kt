package fr.emse.canari.keyboard

/**
 * WHAT THE SHELL TELLS THE PAGE WHEN THE KEYBOARD MOVES (keyboard ride, Android,
 * docs/wiki/frontend/keyboard-and-send-motion.md).
 *
 * The content is never padded for the keyboard any more: a padded WebView shows its LAST frame,
 * cropped or stretched to the new size, until the page has drawn again - 8 frames on a rise (Mi 9T,
 * 2026-11-13) and 13 on a fall (Pixel 6a, 2026-11-14), which no ordering of the padding hides. So the
 * WebView keeps its full height, and the page is told, once per change of the keyboard's inset, its
 * height and the animation it will take: `window.canariImeTarget({ px, durationMs, curve })`. The page
 * lays itself out over the keyboard and rides its pieces on that timing.
 *
 * Pure: compiled by the plain-JVM `android-tests` project, which has no Android classpath (an Android
 * import here breaks that build, and that is the guard).
 */

/** How many points of the keyboard's interpolator are sent: enough for a CSS `linear()` easing. */
const val IME_CURVE_POINTS = 24

/**
 * The keyboard animation `onPrepare` saw: its duration and its interpolator sampled at
 * [IME_CURVE_POINTS] evenly spaced times from 0 to 1. A duration is never negative here - see
 * [rideableImeAnimation], the one way an animation reaches the page.
 */
data class ImeAnimationSpec(val durationMs: Long, val curve: List<Float>) {
    init {
        require(durationMs >= 0) { "an IME animation the page rides has a duration, not $durationMs" }
    }
}

/**
 * The animation the page may ride, or null when there is none to ride.
 *
 * A NEGATIVE DURATION IS A CONTROLLED ANIMATION, NOT A BROKEN ONE (review of #3556, F2):
 * `WindowInsetsAnimation.getDurationMillis()` is -1 when the inset follows a gesture rather than a
 * clock - the predictive-back IME dismissal of targetSdk 36, a `WindowInsetsAnimationController`.
 * The page refuses a negative duration (`parseImeTarget`), so announced as such it refused the whole
 * announcement and kept a keyboard-sized inset after the keyboard was gone. It is announced as a
 * change with no animation instead: the page lays itself out at once, and nothing rides a gesture
 * whose timing nobody knows in advance. A curve that could not be sampled is the same answer.
 *
 * @param durationMs what `getDurationMillis()` returned.
 * @param curve the sampled interpolator ([sampleImeCurve]), or null.
 */
fun rideableImeAnimation(durationMs: Long, curve: List<Float>?): ImeAnimationSpec? =
    if (durationMs < 0 || curve == null) null else ImeAnimationSpec(durationMs, curve)

/**
 * Which keyboard inset the page HOLDS, and which one is on its way to it - so a change is announced
 * once, and an announcement the page refused is announced again on the next insets pass.
 *
 * The inset used to be marked announced before `evaluateJavascript` even ran, so a page that answered
 * anything but `true` was never told again and kept the old layout for good (review of #3556, F2). A
 * value is now HELD only once the page answered `true` for it; while an announcement is in flight
 * its value is not sent a second time (a second announcement ends the ride the first one started).
 * UI thread only, like the listener that drives it.
 */
class ImeAnnouncements {
    /** The inset, in px, the page answered `true` for. */
    var held = 0
        private set

    /** The inset sent and not answered yet, or null. */
    private var inFlight: Int? = null

    /** True when [ime] is neither what the page holds nor what is on its way to it. */
    fun shouldAnnounce(ime: Int): Boolean = ime != (inFlight ?: held)

    /** [ime] was sent to the page. */
    fun sent(ime: Int) {
        inFlight = ime
    }

    /**
     * The page answered for [ime]: [took] when it answered `true`. Returns whether the page holds it.
     * A refused value stays unheld, so the next insets pass with the same value sends it again.
     */
    fun answered(ime: Int, took: Boolean): Boolean {
        if (inFlight == ime) inFlight = null
        if (took) held = ime
        return took
    }

    /** A new document holds nothing yet: whatever was told to the previous one is gone with it. */
    fun forgetPage() {
        held = -1
        inFlight = null
    }
}

/**
 * The interpolator sampled at [IME_CURVE_POINTS] points over `[0..1]`. A null interpolator is LINEAR
 * (`WindowInsetsAnimation` documents null as "no interpolation"). Null when a sample is not finite:
 * the animation is then announced without a curve rather than with a broken one.
 *
 * @param interpolate the interpolator's `getInterpolation`, or null.
 */
fun sampleImeCurve(interpolate: ((Float) -> Float)?): List<Float>? {
    val samples = (0 until IME_CURVE_POINTS).map { i ->
        val t = i.toFloat() / (IME_CURVE_POINTS - 1)
        interpolate?.invoke(t) ?: t
    }
    return if (samples.all { it.isFinite() }) samples else null
}

/**
 * The keyboard's height in the page's CSS px, which on Android's WebView are the display's dp:
 * `px / density`, kept to two decimals so the page can subtract it from `innerHeight` without a
 * rounding step of its own (the page compares heights within 2 CSS px anyway).
 */
fun imeCssPx(px: Int, density: Float): String {
    if (density <= 0f) return "0"
    val hundredths = Math.round(px / density * 100f)
    return "${hundredths / 100}.${(hundredths % 100).toString().padStart(2, '0')}"
}

/** [value] with at most four decimals, `.` as the separator whatever the locale. */
private fun decimal4(value: Float): String {
    val scaled = Math.round(value.toDouble() * 10000.0)
    val sign = if (scaled < 0) "-" else ""
    val abs = Math.abs(scaled)
    val fraction = (abs % 10000).toString().padStart(4, '0').trimEnd('0')
    return if (fraction.isEmpty()) "$sign${abs / 10000}" else "$sign${abs / 10000}.$fraction"
}

/**
 * The script that announces the keyboard to the page: `window.canariImeTarget({...}) === true`, so
 * the WebView answers `true` only when the page took it. `durationMs` and `curve` are absent for a
 * change with no animation (a rotation, a page that asked again). No CSS string crosses the bridge:
 * the page builds its easing from the numbers.
 *
 * @param cssPx the keyboard's height in CSS px, from [imeCssPx].
 * @param animation what `onPrepare` saw for this change, or null.
 */
fun imeAnnouncementScript(cssPx: String, animation: ImeAnimationSpec?): String {
    val fields = StringBuilder("px:").append(cssPx)
    if (animation != null) {
        fields.append(",durationMs:").append(animation.durationMs)
        fields.append(",curve:[").append(animation.curve.joinToString(",") { decimal4(it) }).append(']')
    }
    return "window.canariImeTarget?.({$fields}) === true"
}
