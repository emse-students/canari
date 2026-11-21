package fr.emse.canari

import fr.emse.canari.push.ForegroundGuard
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which pushes act while the app is in front ([ForegroundGuard]).
 *
 * The salon read elsewhere is the case that failed (owner's report, 2026-11-20): the guard dropped
 * `channel_read` whenever the app was in front, on the premise that the device in front is the one
 * reading - while a phone in front showing ANOTHER conversation holds a banner for that salon, and
 * nothing cleared it afterwards.
 */
class ForegroundGuardTest {

    @Test
    fun `a salon read elsewhere is a pure cancellation and acts in front`() {
        assertTrue(ForegroundGuard.actsInForeground("channel_read", isReaction = false))
    }

    @Test
    fun `an MLS frame stays the socket's while the app is in front - one engine writes mls bin`() {
        assertFalse(ForegroundGuard.actsInForeground("message", isReaction = false))
        assertFalse(ForegroundGuard.actsInForeground(null, isReaction = false))
        assertFalse(ForegroundGuard.actsInForeground("channel", isReaction = false))
    }

    @Test
    fun `a reaction rides on social and is not let through, a plain social push is`() {
        assertFalse(ForegroundGuard.actsInForeground("social", isReaction = true))
        assertTrue(ForegroundGuard.actsInForeground("social", isReaction = false))
    }

    @Test
    fun `form reminders and call rings act in front, as before`() {
        assertTrue(ForegroundGuard.actsInForeground("form_reminder", isReaction = false))
        assertTrue(ForegroundGuard.actsInForeground("call_ring", isReaction = false))
    }
}
