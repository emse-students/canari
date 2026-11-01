package fr.emse.canari

import fr.emse.canari.push.CallSoundHold
import fr.emse.canari.push.RepostAlert
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A call holds the phone's sound: a message notification posted during one is posted silent, never
 * dropped (owner, 2026-10-31).
 */
class CallSoundHoldTest {

    @Test
    fun `no call, no native ring - nothing is held`() {
        assertFalse(CallSoundHold.held(callInForeground = false, nativeRings = 0, appRings = false))
    }

    @Test
    fun `the ongoing-call service holds a call - held`() {
        assertTrue(CallSoundHold.held(callInForeground = true, nativeRings = 0, appRings = false))
    }

    @Test
    fun `a call rings natively - held`() {
        assertTrue(CallSoundHold.held(callInForeground = false, nativeRings = 1, appRings = false))
    }

    @Test
    fun `the open app rings a call before the answer - held`() {
        assertTrue(CallSoundHold.held(callInForeground = false, nativeRings = 0, appRings = true))
    }

    @Test
    fun `while held, every post is silent`() {
        for (mode in RepostAlert.Mode.values()) {
            assertEquals(RepostAlert.Mode.SILENT, CallSoundHold.alert(mode, held = true))
        }
    }

    @Test
    fun `when nothing holds it, the post alerts as it would have`() {
        for (mode in RepostAlert.Mode.values()) {
            assertEquals(mode, CallSoundHold.alert(mode, held = false))
        }
    }
}
