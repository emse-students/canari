package fr.emse.canari

import fr.emse.canari.gesture.CapAnchor
import fr.emse.canari.gesture.Edge
import fr.emse.canari.gesture.ExclusionBand
import fr.emse.canari.gesture.bandsFor
import fr.emse.canari.gesture.edgeExclusion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The rect arithmetic behind the back-gesture exclusions of both edges, on the Mi 9T's measured numbers. */
class EdgeGestureExclusionTest {
    // Mi 9T: 1080 x 2340 px, inset 74 px, density 2.75 (440 dpi).
    private val w = 1080
    private val h = 2340
    private val d = 2.75f

    private fun right(inset: Int, top: Int, bottom: Int) =
        edgeExclusion(Edge.RIGHT, w, h, d, inset, top, bottom, CapAnchor.BOTTOM)

    private fun left(inset: Int, top: Int, bottom: Int) =
        edgeExclusion(Edge.LEFT, w, h, d, inset, top, bottom, CapAnchor.CENTER)

    @Test
    fun rightBandCoversTheMeasuredInsetPlusMargin() {
        val band = right(74, 200, 2000)!!
        // 74 + 8 dp (22 px) = 96 px wide, flush with the right edge: x >= 984 covers 1006.
        assertEquals(984, band.left)
        assertEquals(w, band.right)
        assertTrue(band.left <= 1006)
    }

    @Test
    fun aTallListIsCutToItsBottomTwoHundredDp() {
        val band = right(74, 100, 2000)!!
        assertEquals(2000, band.bottom)
        assertEquals(2000 - 550, band.top) // 200 dp = 550 px
    }

    @Test
    fun aShortListKeepsItsOwnExtent() {
        assertEquals(ExclusionBand(984, 800, 1080, 1000), right(74, 800, 1000))
    }

    @Test
    fun noGestureInsetMeansNothingToExclude() {
        assertNull(right(0, 100, 2000))
        assertNull(left(0, 100, 2000))
    }

    @Test
    fun aSpanOutsideOrEmptyOfTheViewIsClamped() {
        assertNull(right(74, 500, 500))
        val band = right(74, -50, 5000)!!
        assertEquals(h, band.bottom)
        assertEquals(h - 550, band.top)
    }

    @Test
    fun leftBandIsFlushWithTheLeftEdgeAndCoversTheMatrixStarts() {
        // The 2026-10-21 matrix lost every swipe started at x = 20 and 60 physical px (inside 74).
        val band = left(74, 250, 2100)!!
        assertEquals(0, band.left)
        assertEquals(96, band.right) // x = 20, 50 and 60 are all inside
    }

    @Test
    fun aTallFeedIsCutToTwoHundredDpAroundItsMiddle() {
        // Feed between a header ending at 250 px and a bottom bar reserved from 2100 px: 1850 px
        // tall, so 550 px are kept, centred - and the matrix row y = 1300 is inside.
        val band = left(74, 250, 2100)!!
        assertEquals(550, band.bottom - band.top)
        assertEquals(250 + (1850 - 550) / 2, band.top)
        assertTrue(1300 in band.top until band.bottom)
    }

    @Test
    fun aShortFeedKeepsItsOwnExtent() {
        assertEquals(ExclusionBand(0, 900, 96, 1200), left(74, 900, 1200))
    }

    @Test
    fun aWiderGestureSettingWidensTheBand() {
        // The inset is the user's setting, not a constant: a 120 px inset gives a 142 px band.
        assertEquals(142, left(120, 900, 1200)!!.right)
    }

    private fun both(spans: Map<Edge, Pair<Int, Int>>) = bandsFor(spans, 74, 74, w, h, d)

    @Test
    fun bothEdgesTravelInOneListLeftThenRight() {
        // setSystemGestureExclusionRects REPLACES the list: one edge's band must never drop the other.
        val bands = both(mapOf(Edge.LEFT to Pair(250, 2100), Edge.RIGHT to Pair(200, 2000)))
        assertEquals(listOf(left(74, 250, 2100)!!, right(74, 200, 2000)!!), bands)
    }

    @Test
    fun aLeftSpanLeavesTheRightBandIntactAndTheReverse() {
        val rightOnly = both(mapOf(Edge.RIGHT to Pair(200, 2000)))
        val leftOnly = both(mapOf(Edge.LEFT to Pair(250, 2100)))
        val withLeft = both(mapOf(Edge.LEFT to Pair(250, 2100), Edge.RIGHT to Pair(200, 2000)))
        assertEquals(rightOnly, withLeft.filter { it.right == w })
        assertEquals(leftOnly, withLeft.filter { it.left == 0 })
    }

    @Test
    fun eachEdgeReadsItsOwnInsetAndAnchor() {
        // 3-button navigation on the left only: the right band survives alone, still bottom-anchored.
        val bands = bandsFor(mapOf(Edge.LEFT to Pair(250, 2100), Edge.RIGHT to Pair(100, 2000)), 0, 74, w, h, d)
        assertEquals(listOf(ExclusionBand(984, 1450, 1080, 2000)), bands)
        assertTrue(both(emptyMap()).isEmpty())
    }
}
