package fr.emse.canari

import fr.emse.canari.gesture.ExclusionBand
import fr.emse.canari.gesture.rightEdgeExclusion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The rect arithmetic behind the right-edge back-gesture exclusion, on the Mi 9T's measured numbers. */
class EdgeGestureExclusionTest {
    // Mi 9T: 1080 x 2340 px, inset 74 px, density 2.75 (440 dpi).
    private val w = 1080
    private val h = 2340
    private val d = 2.75f

    @Test
    fun bandCoversTheMeasuredInsetPlusMargin() {
        val band = rightEdgeExclusion(w, h, d, 74, 200, 2000)!!
        // 74 + 8 dp (22 px) = 96 px wide, flush with the right edge: x >= 984 covers 1006.
        assertEquals(984, band.left)
        assertEquals(w, band.right)
        assertTrue(band.left <= 1006)
    }

    @Test
    fun aTallListIsCutToItsBottomTwoHundredDp() {
        val band = rightEdgeExclusion(w, h, d, 74, 100, 2000)!!
        assertEquals(2000, band.bottom)
        assertEquals(2000 - 550, band.top) // 200 dp = 550 px
    }

    @Test
    fun aShortListKeepsItsOwnExtent() {
        assertEquals(ExclusionBand(984, 800, 1080, 1000), rightEdgeExclusion(w, h, d, 74, 800, 1000))
    }

    @Test
    fun noGestureInsetMeansNothingToExclude() {
        assertNull(rightEdgeExclusion(w, h, d, 0, 100, 2000))
    }

    @Test
    fun aListOutsideOrEmptyOfTheViewIsClamped() {
        assertNull(rightEdgeExclusion(w, h, d, 74, 500, 500))
        val band = rightEdgeExclusion(w, h, d, 74, -50, 5000)!!
        assertEquals(h, band.bottom)
        assertEquals(h - 550, band.top)
    }
}
