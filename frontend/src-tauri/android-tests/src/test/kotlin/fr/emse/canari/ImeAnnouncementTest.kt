package fr.emse.canari

import fr.emse.canari.keyboard.IME_CURVE_POINTS
import fr.emse.canari.keyboard.ImeAnimationSpec
import fr.emse.canari.keyboard.ImeAnnouncements
import fr.emse.canari.keyboard.ImeAnswer
import fr.emse.canari.keyboard.imeAnswerOf
import fr.emse.canari.keyboard.rideableImeAnimation
import fr.emse.canari.keyboard.imeAnnouncementScript
import fr.emse.canari.keyboard.imeCssPx
import fr.emse.canari.keyboard.sampleImeCurve
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
        assertEquals("(function(){var f=window.canariImeTarget;if(typeof f!=='function')return 'not-ready';return f({px:357.98})===true?'taken':'refused';})()", imeAnnouncementScript("357.98", null))
        assertEquals("(function(){var f=window.canariImeTarget;if(typeof f!=='function')return 'not-ready';return f({px:0})===true?'taken':'refused';})()", imeAnnouncementScript("0", null))
    }

    @Test
    fun anAnimatedChangeCarriesItsDurationAndItsCurveAsNumbers() {
        val script = imeAnnouncementScript("357.98", ImeAnimationSpec(285, listOf(0f, 0.12345f, 1.05f, 1f)))
        assertEquals("(function(){var f=window.canariImeTarget;if(typeof f!=='function')return 'not-ready';return f({px:357.98,durationMs:285,curve:[0,0.1235,1.05,1]})===true?'taken':'refused';})()", script)
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

    @Test
    fun aControlledAnimationIsAnnouncedWithoutOne() {
        // Predictive-back IME dismissal (targetSdk 36): getDurationMillis() is -1.
        val curve = sampleImeCurve(null)
        assertNull(rideableImeAnimation(-1, curve))
        assertEquals("(function(){var f=window.canariImeTarget;if(typeof f!=='function')return 'not-ready';return f({px:0})===true?'taken':'refused';})()", imeAnnouncementScript("0", rideableImeAnimation(-1, curve)))
        assertNull(rideableImeAnimation(285, null))
        assertEquals(ImeAnimationSpec(285, curve!!), rideableImeAnimation(285, curve))
    }

    @Test(expected = IllegalArgumentException::class)
    fun aNegativeDurationCannotBeBuiltAtAll() {
        ImeAnimationSpec(-1, listOf(0f, 1f))
    }

    @Test
    fun theAnswerIsClassifiedWhereItIsRead() {
        // evaluateJavascript hands back JSON: the script's strings arrive quoted.
        assertEquals(ImeAnswer.TAKEN, imeAnswerOf("\"taken\""))
        assertEquals(ImeAnswer.NOT_READY, imeAnswerOf("\"not-ready\""))
        assertEquals(ImeAnswer.REFUSED, imeAnswerOf("\"refused\""))
        // A script that threw, or an answer no version of the script gives, is a broken contract.
        assertEquals(ImeAnswer.REFUSED, imeAnswerOf("null"))
        assertEquals(ImeAnswer.REFUSED, imeAnswerOf(null))
        assertEquals(ImeAnswer.REFUSED, imeAnswerOf("true"))
    }

    @Test
    fun theScriptTellsANotReadyPageFromARefusal() {
        val script = imeAnnouncementScript("357.98", null)
        assertTrue(script, script.contains("if(typeof f!=='function')return 'not-ready'"))
        assertTrue(script, script.contains("===true?'taken':'refused'"))
    }

    @Test
    fun aValueIsHeldOnlyOnceThePageTookIt() {
        val ledger = ImeAnnouncements()
        assertTrue(ledger.shouldAnnounce(kb))
        val first = ledger.sent(kb)
        // In flight: the same value is not sent twice (a second announcement ends the first ride).
        assertFalse(ledger.shouldAnnounce(kb))
        assertTrue(ledger.answered(first, ImeAnswer.NOT_READY))
        // Not ready: unheld, so the next insets pass may tell it - and pageReady will.
        assertTrue(ledger.shouldAnnounce(kb))
        assertTrue(ledger.answered(ledger.sent(kb), ImeAnswer.TAKEN))
        assertEquals(kb, ledger.held)
        assertFalse(ledger.shouldAnnounce(kb))
        assertTrue(ledger.shouldAnnounce(0))
    }

    @Test
    fun aRefusalWaitsForThePagesNextReadySignalNotForAnInsetsPass() {
        val ledger = ImeAnnouncements()
        val ticket = ledger.sent(kb)
        assertTrue(ledger.answered(ticket, ImeAnswer.REFUSED))
        // The next insets pass with the same keyboard sends nothing: the same page refuses the same way.
        assertFalse(ledger.shouldAnnounce(kb))
        // The page's ready signal: told again.
        ledger.forgetPage()
        assertTrue(ledger.shouldAnnounce(kb))
        assertTrue(ledger.answered(ledger.sent(kb), ImeAnswer.TAKEN))
        assertEquals(kb, ledger.held)
    }

    @Test
    fun aKeyboardThatMovesAfterARefusalIsStillAnnounced() {
        val ledger = ImeAnnouncements()
        ledger.answered(ledger.sent(kb), ImeAnswer.REFUSED)
        assertTrue(ledger.shouldAnnounce(0))
        ledger.answered(ledger.sent(0), ImeAnswer.TAKEN)
        // Taken: the refusal is over, and the old value is an ordinary change again.
        assertTrue(ledger.shouldAnnounce(kb))
    }

    @Test
    fun anAnswerFromBeforeTheReadySignalChangesNothingWhicheverArrivesFirst() {
        // The page refuses and calls pageReady inside the same script: the ready signal's
        // re-announcement may be sent before the refusal's answer is read.
        val ledger = ImeAnnouncements()
        val refused = ledger.sent(kb)
        ledger.forgetPage()
        val again = ledger.sent(kb)
        assertFalse(ledger.answered(refused, ImeAnswer.REFUSED))
        assertFalse(ledger.shouldAnnounce(kb)) // the re-announcement is still in flight
        assertTrue(ledger.answered(again, ImeAnswer.TAKEN))
        assertEquals(kb, ledger.held)
    }

    @Test
    fun twoAnnouncementsInFlightSettleOnTheLast() {
        val ledger = ImeAnnouncements()
        val rise = ledger.sent(kb)
        val back = ledger.sent(0) // a Back before the rise was answered
        assertFalse(ledger.shouldAnnounce(0))
        ledger.answered(rise, ImeAnswer.TAKEN)
        assertFalse(ledger.shouldAnnounce(0)) // still on its way
        ledger.answered(back, ImeAnswer.TAKEN)
        assertEquals(0, ledger.held)
        assertFalse(ledger.shouldAnnounce(0))
    }

    @Test
    fun aNewDocumentHoldsNothing() {
        val ledger = ImeAnnouncements()
        ledger.answered(ledger.sent(0), ImeAnswer.TAKEN)
        ledger.forgetPage()
        assertTrue(ledger.shouldAnnounce(0))
    }
}
