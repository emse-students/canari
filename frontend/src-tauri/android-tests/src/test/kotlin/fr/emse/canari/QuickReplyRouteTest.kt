package fr.emse.canari

import fr.emse.canari.push.HandedQuickReplies
import fr.emse.canari.push.QuickReplyRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WHO SENDS A REPLY TYPED IN A NOTIFICATION, AND WHAT ITS BANNER SAYS. Read on the Mi 9T, #3912
 * (2026-11-20): a reply typed with the app in front sat queued for about four minutes, the native
 * encrypt refused by the foreground guard and the retry worker standing down for a page that never
 * heard of it. While the guard holds, the page sends it - at once, with no background transition -
 * and the banner says "answered" only once the page holds it durably.
 */
class QuickReplyRouteTest {

    @Test
    fun `while the foreground guard holds the reply goes to the page`() {
        assertEquals(QuickReplyRoute.PAGE, QuickReplyRoute.of(guardHolds = true))
    }

    @Test
    fun `with the guard released the native outbox sends it`() {
        assertEquals(QuickReplyRoute.NATIVE, QuickReplyRoute.of(guardHolds = false))
    }

    @Test
    fun `the banner is answered only on the page's durable acceptance`() {
        // The codes are the Rust `QuickReplyOutcome`'s.
        assertEquals(HandedQuickReplies.Settlement.ANSWERED, HandedQuickReplies.Settlement.of(0)) // sent
        assertEquals(HandedQuickReplies.Settlement.ANSWERED, HandedQuickReplies.Settlement.of(2)) // queued
        assertEquals(HandedQuickReplies.Settlement.NOT_SENT_IN_APP, HandedQuickReplies.Settlement.of(1)) // failed
        assertEquals(HandedQuickReplies.Settlement.STILL_SENDING, HandedQuickReplies.Settlement.of(3)) // put back
        assertEquals(HandedQuickReplies.Settlement.NOT_SENT_RETYPE, HandedQuickReplies.Settlement.of(4)) // lost
        assertEquals(HandedQuickReplies.Settlement.NOT_SENT_RETYPE, HandedQuickReplies.Settlement.of(9)) // unknown
    }

    @Test
    fun `a reply put back stays recorded, every other settlement ends its record`() {
        assertFalse(HandedQuickReplies.Settlement.STILL_SENDING.settles)
        HandedQuickReplies.Settlement.entries
            .filter { it != HandedQuickReplies.Settlement.STILL_SENDING }
            .forEach { assertTrue(it.name, it.settles) }
    }

    @Test
    fun `a dead page's take is lost - only this account's records missing from the file`() {
        val mine = HandedQuickReplies.Handed("r1", "me", "g1")
        val waiting = HandedQuickReplies.Handed("r2", "me", "g1")
        val other = HandedQuickReplies.Handed("r3", "other", "g2")
        assertEquals(
            listOf(mine),
            HandedQuickReplies.unclaimed(listOf(mine, waiting, other), "me", setOf("r2"))
        )
    }
}
