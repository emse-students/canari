package fr.emse.canari

import fr.emse.canari.keyboard.ImeHandoff
import fr.emse.canari.keyboard.ImeStep
import fr.emse.canari.keyboard.imeCssPx
import fr.emse.canari.keyboard.imeStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The keyboard hand-off decision (keyboard-and-send-motion.md), on the Mi 9T's measured keyboard. */
class ImeHandoffTest {
    // Mi 9T, LatinIME, 2026-11-13: the keyboard's top at 1454 of 2340 px -> an 886 px inset.
    private val kb = 886

    @Test
    fun aRiseFromNoKeyboardIsHandedToThePage() {
        assertEquals(ImeStep.HAND_OFF, imeStep(padding = 0, ime = kb, pending = null, pageReachable = true))
    }

    @Test
    fun aRiseWithNoPageIsAppliedAtOnce() {
        assertEquals(ImeStep.APPLY_NOW, imeStep(padding = 0, ime = kb, pending = null, pageReachable = false))
    }

    @Test
    fun theSameTargetAgainWhileHandingOffChangesNothing() {
        // Insets are re-dispatched during the animation; the hand-off in flight already owns them.
        assertEquals(ImeStep.NOTHING, imeStep(padding = 0, ime = kb, pending = kb, pageReachable = true))
    }

    @Test
    fun aFallDuringAHandOffEndsItAndAppliesNow() {
        assertEquals(ImeStep.APPLY_NOW, imeStep(padding = 0, ime = 0, pending = kb, pageReachable = true))
    }

    @Test
    fun aFallIsAppliedAtOnce() {
        assertEquals(ImeStep.APPLY_NOW, imeStep(padding = kb, ime = 0, pending = null, pageReachable = true))
    }

    @Test
    fun aHeightChangeWhileOpenIsAppliedAtOnce() {
        // The emoji row or a taller layout: the page measures that resize itself.
        assertEquals(ImeStep.APPLY_NOW, imeStep(padding = kb, ime = kb + 120, pending = null, pageReachable = true))
    }

    @Test
    fun anUnchangedInsetChangesNothing() {
        assertEquals(ImeStep.NOTHING, imeStep(padding = kb, ime = kb, pending = null, pageReachable = true))
        assertEquals(ImeStep.NOTHING, imeStep(padding = 0, ime = 0, pending = null, pageReachable = true))
    }

    @Test
    fun theTargetIsInCssPxWithTwoDecimals() {
        // 886 px / 2.475 (396 dpi override) = 357.98 CSS px - the page measured 945 - 588 = 357.
        assertEquals("357.98", imeCssPx(kb, 2.475f))
        assertEquals("400.00", imeCssPx(1100, 2.75f))
        assertEquals("0", imeCssPx(kb, 0f))
    }

    @Test
    fun aReloadDuringAHandOffEndsItSoTheNextDispatchHandsOffAgain() {
        val handoff = ImeHandoff()
        val id = handoff.begin(kb)
        // The page reloads before answering: its new document announces itself.
        assertEquals(kb, handoff.end())
        // The old document's late answer decides nothing.
        assertFalse(handoff.isCurrent(id))
        // The same inset dispatched again is a rise to hand off - not NOTHING, which left the
        // keyboard over the composer until it closed.
        assertEquals(ImeStep.HAND_OFF, imeStep(padding = 0, ime = kb, pending = handoff.pending, pageReachable = true))
    }

    @Test
    fun aNewWebViewWithNoHandOffRunningEndsNothing() {
        val handoff = ImeHandoff()
        assertNull(handoff.end())
        assertNull(handoff.pending)
    }

    @Test
    fun onlyTheCurrentHandOffsAnswerCounts() {
        val handoff = ImeHandoff()
        val first = handoff.begin(kb)
        val second = handoff.begin(kb + 120)
        assertFalse(handoff.isCurrent(first))
        assertTrue(handoff.isCurrent(second))
        assertEquals(kb + 120, handoff.end())
        assertFalse(handoff.isCurrent(second))
    }
}
