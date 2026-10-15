package fr.emse.canari.gesture

/**
 * A rectangle in view pixels. Deliberately not `android.graphics.Rect`: this file is compiled by the
 * plain-JVM `android-tests` project, which has no Android classpath (an Android import here breaks
 * that build, and that is the guard).
 */
data class ExclusionBand(val left: Int, val top: Int, val right: Int, val bottom: Int)

/**
 * THE BAND OF THE RIGHT EDGE THE SYSTEM BACK GESTURE MUST NOT TAKE (pure arithmetic, no Android).
 *
 * MEASURED ON A Mi 9T, Android 16, 2026-10-14 (matrix in design-reference): a reply swipe on an OWN
 * bubble started at x >= 406.5 CSS px (1006 of 1080 physical px) never replied - 11 of 11 - because
 * `EdgeBackGestureHandler mEdgeWidthRight=74` physical px belongs to the system, which cancelled the
 * touch (conversation closed, or only the keyboard when it was open). An own bubble ends 12 CSS px
 * from the edge, so its last 17.5 CSS px (about 7 dp) sit inside that 74 px zone.
 *
 * WIDTH: the REAL gesture inset the system reports (`WindowInsets.getSystemGestureInsets().right`,
 * 74 px here) plus [marginDp], never a guessed constant - the inset is the device's and the user's
 * (a gesture-sensitivity setting widens it). Where the system reports 0 (3-button navigation) no
 * back gesture exists on the edge and there is nothing to exclude: null.
 *
 * HEIGHT: [listTopPx]..[listBottomPx] is where the page says its message list is, clamped to the
 * view. Android honours at most 200 dp of exclusion per edge IN TOTAL and silently ignores the
 * excess, so a taller list is cut to its BOTTOM [capDp]: that is where a conversation pinned to its
 * newest messages is read and swiped. Higher bubbles keep the system gesture - the declared cost.
 *
 * @param viewWidthPx the view the rect is applied to (the WebView), in px.
 * @param viewHeightPx its height in px.
 * @param density px per dp, for the cap and the margin.
 */
fun rightEdgeExclusion(
    viewWidthPx: Int,
    viewHeightPx: Int,
    density: Float,
    gestureInsetRightPx: Int,
    listTopPx: Int,
    listBottomPx: Int,
    marginDp: Int = 8,
    capDp: Int = 200,
): ExclusionBand? {
    if (gestureInsetRightPx <= 0 || viewWidthPx <= 0 || viewHeightPx <= 0 || density <= 0f) return null
    val bottom = listBottomPx.coerceIn(0, viewHeightPx)
    val top = listTopPx.coerceIn(0, bottom)
    if (bottom <= top) return null
    val capPx = (capDp * density).toInt()
    val bandTop = maxOf(top, bottom - capPx)
    val bandWidth = gestureInsetRightPx + (marginDp * density).toInt()
    return ExclusionBand(
        left = maxOf(0, viewWidthPx - bandWidth),
        top = bandTop,
        right = viewWidthPx,
        bottom = bottom,
    )
}
