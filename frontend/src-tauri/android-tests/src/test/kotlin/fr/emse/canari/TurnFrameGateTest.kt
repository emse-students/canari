package fr.emse.canari

import fr.emse.canari.orientation.TurnFrameGate
import fr.emse.canari.orientation.isTurn
import fr.emse.canari.orientation.turnLaidOutScript
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The draw hold across a turn: what is a turn, and which proofs release it (screen-orientation.md). */
class TurnFrameGateTest {
    @Test
    fun aTurnIsTheBoxFlippingShapeAndNothingElse() {
        assertTrue(isTurn(1080, 2340, 2340, 1080))
        assertTrue(isTurn(2340, 1080, 1080, 2340))
        // The keyboard (adjustResize) shrinks one side and keeps the shape: no hold for it.
        assertFalse(isTurn(1080, 2340, 1080, 1400))
        assertFalse(isTurn(2340, 1080, 2340, 500))
        // The first layout comes from nothing: no frame at an old size to hide.
        assertFalse(isTurn(0, 0, 1080, 2340))
        assertFalse(isTurn(1080, 2340, 0, 0))
    }

    @Test
    fun aFrameIsBelievedOnlyAfterThePageHasTheShape() {
        val gate = TurnFrameGate()
        val turn = gate.hold()
        // A visual-state answer before the page had the new shape is a frame at the OLD size
        // (Mi 9T, 2026-11-15: answered 24-31 ms after the resize, the old layout still on it).
        assertFalse(gate.frameReady(turn))
        assertTrue(gate.holding)
        assertTrue(gate.laidOut(turn))
        // The page answers once per turn; a second answer posts nothing more.
        assertFalse(gate.laidOut(turn))
        assertTrue(gate.frameReady(turn))
        assertFalse(gate.holding)
    }

    @Test
    fun theNewestTurnAloneMovesTheHold() {
        val gate = TurnFrameGate()
        val first = gate.hold()
        assertTrue(gate.laidOut(first))
        // Turned back before the first frame came: that frame is at a size no longer on screen.
        val second = gate.hold()
        assertFalse(gate.frameReady(first))
        assertFalse(gate.laidOut(first))
        assertTrue(gate.holding)
        assertTrue(gate.laidOut(second))
        assertTrue(gate.frameReady(second))
        assertFalse(gate.holding)
        // A late answer after the release changes nothing.
        assertFalse(gate.laidOut(second))
        assertFalse(gate.frameReady(second))
        assertFalse(gate.holding)
    }

    @Test
    fun theScriptAsksForTheTurnsShapeAndAnswersWithItsToken() {
        val script = turnLaidOutScript(7, true)
        assertTrue(script.contains("(innerWidth>innerHeight)===true"))
        assertTrue(script.contains("var t='7'"))
        assertTrue(script.contains("canariTurn.laidOut(t)"))
        assertTrue(script.contains("removeEventListener('resize',c)"))
        assertTrue(turnLaidOutScript(8, false).contains("(innerWidth>innerHeight)===false"))
    }
}
