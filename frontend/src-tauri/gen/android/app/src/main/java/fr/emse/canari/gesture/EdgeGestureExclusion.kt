package fr.emse.canari.gesture

/**
 * A rectangle in view pixels. Deliberately not `android.graphics.Rect`: this file is compiled by the
 * plain-JVM `android-tests` project, which has no Android classpath (an Android import here breaks
 * that build, and that is the guard).
 */
data class ExclusionBand(val left: Int, val top: Int, val right: Int, val bottom: Int)

/** Which screen edge a band is flush with. Each edge has its OWN 200 dp budget in Android. */
enum class Edge { LEFT, RIGHT }

/**
 * Which part of a span taller than the budget is kept, because the two surfaces are swiped in
 * different places.
 *
 * - [BOTTOM]: the conversation's message list. A conversation is pinned to its newest messages, so
 *   the bubbles a thumb swipes to reply to are at the bottom of the list.
 * - [CENTER]: the posts feed, swiped right to the camera. A feed has no "newest at the bottom": the
 *   thumb starts the swipe in the middle of the screen, which is also where the 2026-10-21 Mi 9T
 *   matrix started every cell (y = 1300 of 2340 physical px). The BOTTOM 200 dp of the feed would
 *   have left that row uncovered.
 */
enum class CapAnchor { BOTTOM, CENTER }

/**
 * THE BAND OF ONE EDGE THE SYSTEM BACK GESTURE MUST NOT TAKE (pure arithmetic, no Android).
 *
 * MEASURED ON A Mi 9T, Android 16 (matrices in design-reference): a swipe started inside
 * `EdgeBackGestureHandler mEdgeWidthRight/Left=74` physical px (30 CSS px) belongs to the system,
 * which cancels the touch and goes Back. On the RIGHT edge it ate a reply swipe on an own bubble
 * (11 of 11, 2026-10-14); on the LEFT edge it ate the feed's swipe to the camera (8 of 8,
 * 2026-10-21).
 *
 * WIDTH: the REAL gesture inset the system reports for that edge
 * (`WindowInsets.getSystemGestureInsets()`, 74 px on the Mi 9T) plus [marginDp], never a guessed
 * constant - the inset is the device's and the user's (a gesture-sensitivity setting widens it).
 * Where the system reports 0 (3-button navigation) no back gesture exists on the edge and there is
 * nothing to exclude: null.
 *
 * HEIGHT: [spanTopPx]..[spanBottomPx] is where the page says its surface is, clamped to the view.
 * Android honours at most 200 dp of exclusion per edge IN TOTAL and silently ignores the excess
 * (Android 10 also caps the vertical extent of the excluded region at 200 dp), so a taller span is
 * cut to [capDp] around [anchor]. The rest of the edge keeps the system gesture - the declared cost.
 *
 * @param viewWidthPx the view the rect is applied to (the WebView), in px.
 * @param viewHeightPx its height in px.
 * @param density px per dp, for the cap and the margin.
 * @param gestureInsetPx the system gesture inset of [edge], in px.
 */
fun edgeExclusion(
    edge: Edge,
    viewWidthPx: Int,
    viewHeightPx: Int,
    density: Float,
    gestureInsetPx: Int,
    spanTopPx: Int,
    spanBottomPx: Int,
    anchor: CapAnchor,
    marginDp: Int = 8,
    capDp: Int = 200,
): ExclusionBand? {
    if (gestureInsetPx <= 0 || viewWidthPx <= 0 || viewHeightPx <= 0 || density <= 0f) return null
    val bottom = spanBottomPx.coerceIn(0, viewHeightPx)
    val top = spanTopPx.coerceIn(0, bottom)
    if (bottom <= top) return null
    val capPx = (capDp * density).toInt()
    val (bandTop, bandBottom) = when {
        bottom - top <= capPx -> Pair(top, bottom)
        anchor == CapAnchor.BOTTOM -> Pair(bottom - capPx, bottom)
        else -> {
            val start = top + (bottom - top - capPx) / 2
            Pair(start, start + capPx)
        }
    }
    val bandWidth = minOf(viewWidthPx, gestureInsetPx + (marginDp * density).toInt())
    return when (edge) {
        Edge.LEFT -> ExclusionBand(left = 0, top = bandTop, right = bandWidth, bottom = bandBottom)
        Edge.RIGHT -> ExclusionBand(left = viewWidthPx - bandWidth, top = bandTop, right = viewWidthPx, bottom = bandBottom)
    }
}
