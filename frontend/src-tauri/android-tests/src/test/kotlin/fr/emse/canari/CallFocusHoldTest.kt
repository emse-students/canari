package fr.emse.canari

import fr.emse.canari.call.CallFocusHold
import fr.emse.canari.call.FocusChange
import fr.emse.canari.call.FocusStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A CALL THAT LOSES THE AUDIO FOCUS IS HELD, NEVER HUNG UP, AND EACH CHANGE IS SAID ONCE (D056). */
class CallFocusHoldTest {
    @Test
    fun aTransientLossHoldsAndTheGainReleases() {
        val hold = CallFocusHold()
        assertEquals(FocusStep.HOLD, hold.on(FocusChange.LOSS_TRANSIENT))
        assertTrue(hold.held)
        assertEquals(FocusStep.RELEASE, hold.on(FocusChange.GAIN))
        assertFalse(hold.held)
    }

    @Test
    fun aPermanentLossHoldsTooAndNeverEndsTheCall() {
        val hold = CallFocusHold()
        assertEquals(FocusStep.HOLD, hold.on(FocusChange.LOSS))
        assertEquals(FocusStep.RELEASE, hold.on(FocusChange.GAIN))
    }

    @Test
    fun aSecondLossWhileHeldIsNoStep() {
        val hold = CallFocusHold()
        hold.on(FocusChange.LOSS_TRANSIENT)
        assertEquals(FocusStep.NONE, hold.on(FocusChange.LOSS))
        assertEquals(FocusStep.NONE, hold.on(FocusChange.LOSS_TRANSIENT))
        assertTrue(hold.held)
    }

    @Test
    fun aGainWithNoLossBeforeItSaysNothing() {
        val hold = CallFocusHold()
        assertEquals(FocusStep.NONE, hold.on(FocusChange.GAIN))
        assertFalse(hold.held)
    }

    @Test
    fun duckingAndUnknownChangesLeaveTheCallAsItIs() {
        val hold = CallFocusHold()
        assertEquals(FocusStep.NONE, hold.on(FocusChange.LOSS_TRANSIENT_CAN_DUCK))
        assertEquals(FocusStep.NONE, hold.on(FocusChange.OTHER))
        assertFalse(hold.held)
        hold.on(FocusChange.LOSS_TRANSIENT)
        assertEquals(FocusStep.NONE, hold.on(FocusChange.LOSS_TRANSIENT_CAN_DUCK))
        assertTrue(hold.held)
    }
}
