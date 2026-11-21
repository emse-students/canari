package fr.emse.canari

import fr.emse.canari.push.FixedNotifIds
import fr.emse.canari.push.OutboxNudge
import fr.emse.canari.push.OutboxNudge.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE NUDGE FOLLOWS THE OUTBOX MIRROR. Seen on the Mi 9T, 2026-11-21: a queued quick reply was
 * delivered by the retry worker and "Vous avez peut-etre des messages en attente" stayed in the
 * shade until the app was opened, because nothing withdrew it.
 */
class OutboxNudgeTest {

    @Test
    fun `a drain that leaves the mirror empty withdraws the nudge`() {
        assertEquals(Decision.WITHDRAW, OutboxNudge.decide(queued = 0, asked = false))
    }

    @Test
    fun `a drain that leaves sends keeps whatever stands`() {
        assertEquals(Decision.KEEP, OutboxNudge.decide(queued = 2, asked = false))
    }

    @Test
    fun `an ask over an emptied mirror withdraws instead of posting`() {
        // The drain that emptied the queue ran between the caller's drain and its ask: the mirror,
        // read under the outbox lock, has the last word.
        assertEquals(Decision.WITHDRAW, OutboxNudge.decide(queued = 0, asked = true))
    }

    @Test
    fun `an ask with sends queued posts`() {
        assertEquals(Decision.POST, OutboxNudge.decide(queued = 1, asked = true))
    }

    @Test
    fun `an unreadable mirror is not an empty queue`() {
        assertEquals(Decision.UNKNOWN, OutboxNudge.decide(queued = null, asked = false))
        // The caller saw sends remain: a possibly stale nudge beats a hidden unsent reply.
        assertEquals(Decision.POST, OutboxNudge.decide(queued = null, asked = true))
    }

    @Test
    fun `the nudge has its own id, never the worker's foreground notice`() {
        assertNotEquals(FixedNotifIds.WORKER_FOREGROUND, FixedNotifIds.OUTBOX_NUDGE)
        assertTrue(FixedNotifIds.OUTBOX_NUDGE in FixedNotifIds.ALL)
        assertTrue(FixedNotifIds.WORKER_FOREGROUND in FixedNotifIds.ALL)
    }

    @Test
    fun `the nudge's id is below the conversation counter, so no install ever stored it for a conversation`() {
        // The counter starts at 1000 and only grows; an id it already stored is never moved.
        assertTrue(FixedNotifIds.OUTBOX_NUDGE < 1000)
    }

    @Test
    fun `a record under the old id is a pre-update nudge only when neither ongoing nor foreground`() {
        val old = FixedNotifIds.WORKER_FOREGROUND
        assertTrue(OutboxNudge.isPreUpdateNudge(old, ongoing = false, foregroundService = false))
        // The worker's own notice: ongoing always, a foreground-service record once promoted.
        assertFalse(OutboxNudge.isPreUpdateNudge(old, ongoing = true, foregroundService = false))
        assertFalse(OutboxNudge.isPreUpdateNudge(old, ongoing = true, foregroundService = true))
        assertFalse(OutboxNudge.isPreUpdateNudge(old, ongoing = false, foregroundService = true))
        // Any other id is never the leftover.
        assertFalse(OutboxNudge.isPreUpdateNudge(FixedNotifIds.OUTBOX_NUDGE, ongoing = false, foregroundService = false))
    }
}
