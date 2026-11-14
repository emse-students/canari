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
 * What the page answered to an announcement, classified where the answer is read ([imeAnswerOf]) -
 * never a string compared at each call site.
 */
enum class ImeAnswer {
    /** The page took the keyboard: it is laid out over it. */
    TAKEN,

    /**
     * No `window.canariImeTarget` yet: the document is loading, or a new one replaced it. Not a
     * defect - the page says when it is ready (`canariIme.pageReady`), and is announced then.
     */
    NOT_READY,

    /**
     * The page has the hook and refused what it was told, or the script failed: a BROKEN CONTRACT
     * between the shell and the page. Accused at `Log.e`; the page asks again (`pageReady`) when what
     * it refused carried an animation, and is then told the inset without one.
     */
    REFUSED,
}

/**
 * The answer `evaluateJavascript` handed back for [imeAnnouncementScript]: a JSON value, so the
 * script's strings arrive quoted (`"taken"`). Anything but the two expected strings - `"refused"`,
 * `null` (the script threw), a value no version of the script returns - is [ImeAnswer.REFUSED]: a
 * shell and a page that disagree must be accused, never read as "not ready yet".
 */
fun imeAnswerOf(raw: String?): ImeAnswer = when (raw) {
    "\"taken\"" -> ImeAnswer.TAKEN
    "\"not-ready\"" -> ImeAnswer.NOT_READY
    else -> ImeAnswer.REFUSED
}

/** One announcement on its way: the inset it carried, and the document it was made to. */
data class ImeTicket(val page: Int, val ime: Int)

/**
 * Which keyboard inset the page HOLDS, and which one is on its way to it - so a change is announced
 * once, and nothing is announced twice for the same reason.
 *
 * The inset used to be marked announced before `evaluateJavascript` even ran, so a page that answered
 * anything but `true` was never told again and kept the old layout for good (review of #3556, F2). A
 * value is now HELD only once the page answered [ImeAnswer.TAKEN] for it; while an announcement is in
 * flight its value is not sent a second time (a second announcement ends the ride the first one
 * started).
 *
 * WHAT A REFUSAL WAITS FOR (second review of #3556). [ImeAnswer.NOT_READY] keeps the value unheld,
 * and the page's `pageReady` announces it. [ImeAnswer.REFUSED] is not sent again by the next insets
 * pass either - the same announcement to the same page is refused the same way, and with a steady
 * keyboard no pass came at all, so the page stayed desynced. It waits for the page's next READY
 * signal: the page asks again (`pageReady`) right after refusing an animated announcement, and a new
 * document asks anyway. A ready signal forgets the page ([forgetPage]), so an answer still on its way
 * from before it ([ImeTicket.page]) changes nothing, whichever arrives first. UI thread only, like
 * the listener that drives it.
 */
class ImeAnnouncements {
    /** The inset, in px, the page answered [ImeAnswer.TAKEN] for. */
    var held = 0
        private set

    /** The document announcements are made to: a ready signal starts a new one. */
    private var page = 0

    /** The inset sent and not answered yet, or null. */
    private var inFlight: Int? = null

    /** The inset this page REFUSED, owed to its next ready signal, or null. */
    private var refused: Int? = null

    /** True when [ime] is neither what the page holds, nor on its way, nor refused by this page. */
    fun shouldAnnounce(ime: Int): Boolean = ime != (inFlight ?: refused ?: held)

    /** [ime] was sent to the page: the ticket its answer is matched with. */
    fun sent(ime: Int): ImeTicket {
        inFlight = ime
        return ImeTicket(page, ime)
    }

    /**
     * The page answered [answer] for [ticket]. Returns false when the answer is STALE - made by a page
     * that has since said it is ready again - and changed nothing.
     */
    fun answered(ticket: ImeTicket, answer: ImeAnswer): Boolean {
        if (ticket.page != page) return false
        if (inFlight == ticket.ime) inFlight = null
        when (answer) {
            ImeAnswer.TAKEN -> {
                held = ticket.ime
                refused = null
            }
            ImeAnswer.REFUSED -> refused = ticket.ime
            ImeAnswer.NOT_READY -> Unit
        }
        return true
    }

    /**
     * The page said it is ready to be told the keyboard from scratch (a new document, or a page that
     * refused an announcement): it holds nothing, owes nothing, and answers to earlier announcements
     * are stale.
     */
    fun forgetPage() {
        page++
        held = -1
        inFlight = null
        refused = null
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
 * The script that announces the keyboard to the page. It answers which [ImeAnswer] it is - `'taken'`
 * when `window.canariImeTarget(...)` returned `true`, `'not-ready'` when the page has no hook yet,
 * `'refused'` otherwise - so the shell tells a page still loading from a page that refused
 * ([imeAnswerOf]). `durationMs` and `curve` are absent for a change with no animation (a rotation, a
 * page that asked again). No CSS string crosses the bridge: the page builds its easing from the
 * numbers.
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
    return "(function(){var f=window.canariImeTarget;" +
        "if(typeof f!=='function')return 'not-ready';" +
        "return f({$fields})===true?'taken':'refused';})()"
}
