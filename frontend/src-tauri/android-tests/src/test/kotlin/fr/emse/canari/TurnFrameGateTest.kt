package fr.emse.canari

import fr.emse.canari.orientation.TURN_SIZE_STOP_SCRIPT
import fr.emse.canari.orientation.TurnAbandon
import fr.emse.canari.orientation.TurnFrameGate
import fr.emse.canari.orientation.isTurn
import fr.emse.canari.orientation.isUnrotatedFlip
import fr.emse.canari.orientation.pageMatchesBox
import fr.emse.canari.orientation.turnSizeScript
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The draw hold across a turn: what is a turn, which proofs release it, which events end it (screen-orientation.md). */
class TurnFrameGateTest {
    @Test
    fun aTurnIsARotationThatFlipsTheBox() {
        assertTrue(isTurn(0, 1, 1080, 2340, 2340, 1080))
        assertTrue(isTurn(1, 0, 2340, 1080, 1080, 2340))
        // No rotation: a split-screen divider, a freeform window, a fold or a split-screen keyboard
        // can flip the box, and none of them may hold the draw.
        assertFalse(isTurn(0, 0, 1080, 1200, 1080, 900))
        assertFalse(isTurn(1, 1, 2340, 1080, 1000, 1080))
        // A 180-degree turn keeps the shape: nothing to lay out again.
        assertFalse(isTurn(1, 3, 2340, 1080, 2340, 1080))
        // The keyboard (adjustResize) shrinks one side.
        assertFalse(isTurn(0, 0, 1080, 2340, 1080, 1400))
        // The first layout comes from nothing.
        assertFalse(isTurn(-1, 0, 0, 0, 1080, 2340))
    }

    @Test
    fun aFlipWithTheRotationReadUnchangedIsNamedButNotHeld() {
        // A split screen or a fold - or a turn whose rotation was read stale: the caller logs it at WARN.
        assertTrue(isUnrotatedFlip(0, 0, 1080, 1200, 1080, 900))
        assertFalse(isTurn(0, 0, 1080, 1200, 1080, 900))
        // A real turn, a keyboard resize and a 180-degree turn are not that case.
        assertFalse(isUnrotatedFlip(0, 1, 1080, 2340, 2340, 1080))
        assertFalse(isUnrotatedFlip(0, 0, 1080, 2340, 1080, 1400))
        assertFalse(isUnrotatedFlip(1, 3, 2340, 1080, 2340, 1080))
    }

    @Test
    fun thePageHasTheBoxWithinOneCssPxWhateverItsShape() {
        // The Mi 9T: 2340x1080 px at 2.75 is 850.9x392.7 CSS px; the page rounds to whole px.
        assertTrue(pageMatchesBox(851.0, 393.0, 2.75, 2340, 1080))
        assertFalse(pageMatchesBox(393.0, 851.0, 2.75, 2340, 1080))
        // NEAR SQUARE (review of #3626): 1081x1080 px at 2.75 is 393x393 CSS px. A shape test
        // (innerWidth > innerHeight) never said landscape here and the draw stayed held for ever.
        assertTrue(pageMatchesBox(393.0, 393.0, 2.75, 1081, 1080))
        assertFalse(pageMatchesBox(395.0, 393.0, 2.75, 1081, 1080))
        // A non-finite or absurd report never matches.
        assertFalse(pageMatchesBox(Double.NaN, 393.0, 2.75, 1081, 1080))
        assertFalse(pageMatchesBox(393.0, 393.0, 0.0, 1081, 1080))
    }

    @Test
    fun aFrameIsProvedOnlyAfterThePageHasTheBox() {
        val gate = TurnFrameGate()
        val turn = gate.hold(2340, 1080, 0)
        // The page still at the old size: no proof posted (it would be answered by an old frame,
        // Mi 9T 2026-11-15, 2 turns in 8).
        assertNull(gate.pageSize(turn.number, 393.0, 851.0, 2.75))
        val proof = gate.pageSize(turn.number, 851.0, 393.0, 2.75)
        assertNotNull(proof)
        // One proof in flight per box.
        assertNull(gate.pageSize(turn.number, 851.0, 393.0, 2.75))
        assertTrue(gate.holding)
        assertEquals(turn, gate.frameReady(proof!!))
        assertFalse(gate.holding)
        // A late callback after the release changes nothing.
        assertNull(gate.frameReady(proof))
    }

    @Test
    fun aBoxMovedWhileHeldWaitsForThePageAtTheNewBox() {
        val gate = TurnFrameGate()
        val turn = gate.hold(2340, 1080, 0)
        val first = gate.pageSize(turn.number, 851.0, 393.0, 2.75)!!
        assertTrue(gate.rebox(2340, 1000))
        assertFalse(gate.rebox(2340, 1000))
        // The proof posted for the previous box releases nothing.
        assertNull(gate.frameReady(first))
        assertTrue(gate.holding)
        assertNull(gate.pageSize(turn.number, 851.0, 393.0, 2.75))
        val second = gate.pageSize(turn.number, 851.0, 364.0, 2.75)!!
        assertEquals(turn.number, gate.frameReady(second)!!.number)
    }

    @Test
    fun theNewestTurnAloneMovesTheHoldAndEachKeepsItsStart() {
        val gate = TurnFrameGate()
        val first = gate.hold(2340, 1080, 100)
        val firstProof = gate.pageSize(first.number, 851.0, 393.0, 2.75)!!
        val second = gate.hold(1080, 2340, 900)
        assertEquals(100L, first.startedAtNanos)
        assertEquals(900L, second.startedAtNanos)
        assertNull(gate.frameReady(firstProof))
        assertNull(gate.pageSize(first.number, 393.0, 851.0, 2.75))
        assertTrue(gate.holding)
        val proof = gate.pageSize(second.number, 393.0, 851.0, 2.75)!!
        assertEquals(second, gate.frameReady(proof))
        assertFalse(gate.holding)
    }

    @Test
    fun anEventProvingNoAnswerCanComeReleasesTheHold() {
        // A new document, the WebView detached, the activity paused or stopped: each calls abandon.
        val gate = TurnFrameGate()
        assertNull(gate.abandon())
        val turn = gate.hold(2340, 1080, 0)
        val proof = gate.pageSize(turn.number, 851.0, 393.0, 2.75)!!
        assertEquals(turn, gate.abandon())
        assertFalse(gate.holding)
        // The abandoned turn's late answers release nothing and hold nothing.
        assertNull(gate.frameReady(proof))
        assertNull(gate.pageSize(turn.number, 851.0, 393.0, 2.75))
        assertNull(gate.abandon())
    }

    @Test
    fun anUnresponsiveRendererEndsTheHoldLikeTheOtherTerminalEvents() {
        // A hung renderer never reports its size nor commits a frame: the WebView's own
        // `onRenderProcessUnresponsive` is the event that proves it, never a clock.
        assertTrue(TurnAbandon.entries.contains(TurnAbandon.UNRESPONSIVE))
        for (why in TurnAbandon.entries) {
            val gate = TurnFrameGate()
            val turn = gate.hold(2340, 1080, 0)
            assertEquals("$why", turn, gate.abandon())
            assertFalse("$why", gate.holding)
        }
    }

    @Test
    fun theScriptReportsTheSizeAndReplacesThePreviousListener() {
        val script = turnSizeScript(7)
        assertTrue(script.contains("canariTurn.size(7,innerWidth,innerHeight,devicePixelRatio)"))
        assertTrue(script.contains("removeEventListener('resize',o)"))
        assertTrue(script.contains("addEventListener('resize',c)"))
        assertTrue(TURN_SIZE_STOP_SCRIPT.contains("removeEventListener('resize',o)"))
    }
}
