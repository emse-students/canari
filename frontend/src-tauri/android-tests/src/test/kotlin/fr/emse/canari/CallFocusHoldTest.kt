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

    /**
     * A PERMANENT LOSS IS NEVER FOLLOWED BY A GAIN (a video started in another app): no GAIN ever
     * comes, so the way back is the member's tap or the return on screen, which ASK again.
     */
    @Test
    fun aPermanentLossWithNoGainIsReleasedOnlyByAGrantedAsk() {
        val hold = CallFocusHold()
        assertEquals(FocusStep.HOLD, hold.on(FocusChange.LOSS))
        assertTrue(hold.wantsAsk)
        // The member taps while another app still holds the focus: refused, still held, said.
        assertEquals(FocusStep.STILL_HELD, hold.onAsk(granted = false))
        assertTrue(hold.held)
        // The member taps again once that app let go: granted, released.
        assertEquals(FocusStep.RELEASE, hold.onAsk(granted = true))
        assertFalse(hold.held)
        assertFalse(hold.wantsAsk)
    }

    /**
     * A FOCUS REFUSED AT THE CALL'S START (a cellular call in progress) HOLDS LIKE A PERMANENT LOSS:
     * no LOSS will ever arrive, so the call starts held and only a granted ask releases it.
     */
    @Test
    fun aFocusRefusedAtTheStartHoldsUntilAGrantedAsk() {
        val hold = CallFocusHold()
        assertEquals(FocusStep.HOLD, hold.onOpen(granted = false))
        assertTrue(hold.held)
        assertTrue(hold.wantsAsk)
        // The phone call goes on: the member's tap is refused, the hold stays.
        assertEquals(FocusStep.STILL_HELD, hold.onAsk(granted = false))
        // The phone call ended: the next ask is granted, the member's microphone comes back.
        assertEquals(FocusStep.RELEASE, hold.onAsk(granted = true))
        assertFalse(hold.held)
    }

    @Test
    fun aFocusGrantedAtTheStartChangesNothing() {
        val hold = CallFocusHold()
        assertEquals(FocusStep.NONE, hold.onOpen(granted = true))
        assertFalse(hold.held)
        assertFalse(hold.wantsAsk)
        // A loss afterwards holds as before.
        assertEquals(FocusStep.HOLD, hold.on(FocusChange.LOSS_TRANSIENT))
    }

    @Test
    fun anAskAnsweredWhenNothingIsHeldChangesNothing() {
        val hold = CallFocusHold()
        assertEquals(FocusStep.NONE, hold.onAsk(granted = true))
        assertEquals(FocusStep.NONE, hold.onAsk(granted = false))
        hold.on(FocusChange.LOSS_TRANSIENT)
        hold.on(FocusChange.GAIN)
        assertEquals(FocusStep.NONE, hold.onAsk(granted = true))
    }

    @Test
    fun aGrantedAskThenALateGainSaysNothingTwice() {
        val hold = CallFocusHold()
        hold.on(FocusChange.LOSS_TRANSIENT)
        assertEquals(FocusStep.RELEASE, hold.onAsk(granted = true))
        assertEquals(FocusStep.NONE, hold.on(FocusChange.GAIN))
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
