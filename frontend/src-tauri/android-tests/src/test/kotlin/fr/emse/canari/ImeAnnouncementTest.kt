package fr.emse.canari

import fr.emse.canari.keyboard.IME_CURVE_POINTS
import fr.emse.canari.keyboard.ImeAnimationSpec
import fr.emse.canari.keyboard.imeAnnouncementScript
import fr.emse.canari.keyboard.imeCssPx
import fr.emse.canari.keyboard.sampleImeCurve
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The keyboard announcement to the page (keyboard-and-send-motion.md), on the Mi 9T's keyboard. */
class ImeAnnouncementTest {
    // Mi 9T, LatinIME, 2026-11-13: the keyboard's top at 1454 of 2340 px -> an 886 px inset.
    private val kb = 886

    @Test
    fun theTargetIsInCssPxWithTwoDecimals() {
        // 886 px / 2.475 (396 dpi override) = 357.98 CSS px - the page measured 945 - 588 = 357.
        assertEquals("357.98", imeCssPx(kb, 2.475f))
        assertEquals("400.00", imeCssPx(1100, 2.75f))
        assertEquals("0", imeCssPx(kb, 0f))
    }

    @Test
    fun aNullInterpolatorIsSampledLinear() {
        val curve = sampleImeCurve(null)!!
        assertEquals(IME_CURVE_POINTS, curve.size)
        assertEquals(0f, curve.first(), 0f)
        assertEquals(1f, curve.last(), 0f)
        assertEquals(1f / (IME_CURVE_POINTS - 1), curve[1], 1e-6f)
    }

    @Test
    fun theInterpolatorIsSampledFromZeroToOne() {
        val seen = mutableListOf<Float>()
        val curve = sampleImeCurve { t -> seen.add(t); t * t }!!
        assertEquals(IME_CURVE_POINTS, seen.size)
        assertEquals(0f, seen.first(), 0f)
        assertEquals(1f, seen.last(), 0f)
        assertEquals(seen.map { it * it }, curve)
    }

    @Test
    fun aCurveWithANonFiniteSampleIsNotSent() {
        assertNull(sampleImeCurve { t -> if (t > 0.5f) Float.NaN else t })
        assertNull(sampleImeCurve { _ -> Float.POSITIVE_INFINITY })
    }

    @Test
    fun aChangeWithNoAnimationAnnouncesTheHeightAlone() {
        assertEquals("window.canariImeTarget?.({px:357.98}) === true", imeAnnouncementScript("357.98", null))
        assertEquals("window.canariImeTarget?.({px:0}) === true", imeAnnouncementScript("0", null))
    }

    @Test
    fun anAnimatedChangeCarriesItsDurationAndItsCurveAsNumbers() {
        val script = imeAnnouncementScript("357.98", ImeAnimationSpec(285, listOf(0f, 0.12345f, 1.05f, 1f)))
        assertEquals("window.canariImeTarget?.({px:357.98,durationMs:285,curve:[0,0.1235,1.05,1]}) === true", script)
    }

    @Test
    fun aCurveIsWrittenWithADotWhateverTheLocaleAndKeepsItsSign() {
        val previous = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.FRANCE)
            val script = imeAnnouncementScript("1.00", ImeAnimationSpec(10, listOf(-0.05f, 0.5f)))
            assertTrue(script, script.contains("curve:[-0.05,0.5]"))
        } finally {
            java.util.Locale.setDefault(previous)
        }
    }
}
