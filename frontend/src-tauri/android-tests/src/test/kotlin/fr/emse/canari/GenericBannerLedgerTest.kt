package fr.emse.canari

import fr.emse.canari.push.GenericBannerLedger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * NOTIF-10 design (b): a generic "nouveau message" banner left by a push that MLS refused for good
 * is replaced by the real line the WebView posts for the same message, in whichever order the two
 * arrive. Measured on the Mi 9T, 2026-10-06: the engine consumed the generation ~1.4 s before the
 * push decrypt, the WebView's real post landed FIRST and the generic one was appended after it.
 */
class GenericBannerLedgerTest {

    private val g = "group-a"

    @Test
    fun `a real post after a generic banner supersedes it, first in first out`() {
        val ledger = GenericBannerLedger()
        ledger.pushQueued(g)
        ledger.pushQueued(g)
        assertFalse(ledger.refusedCoveredByRealPost(g))
        ledger.genericPosted(g, 100L)
        assertFalse(ledger.refusedCoveredByRealPost(g))
        ledger.genericPosted(g, 200L)

        assertEquals(100L, ledger.realPosted(g))
        assertEquals(200L, ledger.realPosted(g))
        assertEquals("nothing left to supersede", 0L, ledger.realPosted(g))
    }

    @Test
    fun `a real post BEFORE the refusal covers it, so no generic banner is added next to it`() {
        val ledger = GenericBannerLedger()
        ledger.pushQueued(g)
        assertEquals("no generic yet to replace", 0L, ledger.realPosted(g))
        assertTrue(ledger.refusedCoveredByRealPost(g))
        assertFalse("the credit is spent once", ledger.refusedCoveredByRealPost(g))
    }

    @Test
    fun `a real post with no push in flight leaves no credit behind`() {
        val ledger = GenericBannerLedger()
        // The ACK won the race: no push was ever sent for this message.
        assertEquals(0L, ledger.realPosted(g))
        ledger.pushQueued(g)
        assertFalse("a stale credit must not swallow a later generic banner", ledger.refusedCoveredByRealPost(g))
    }

    @Test
    fun `credits never outlive the pushes in flight`() {
        val ledger = GenericBannerLedger()
        ledger.pushQueued(g)
        ledger.realPosted(g)
        ledger.pushFinished(g)
        ledger.pushQueued(g)
        assertFalse(ledger.refusedCoveredByRealPost(g))
    }

    @Test
    fun `groups do not share state`() {
        val ledger = GenericBannerLedger()
        ledger.pushQueued(g)
        ledger.genericPosted(g, 5L)
        assertEquals(0L, ledger.realPosted("group-b"))
        assertEquals(5L, ledger.realPosted(g))
    }
}
