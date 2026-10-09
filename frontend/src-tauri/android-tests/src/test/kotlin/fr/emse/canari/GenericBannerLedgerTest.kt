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

        assertEquals(listOf(100L), ledger.realPosted(g, 1))
        assertEquals(listOf(200L), ledger.realPosted(g, 1))
        assertEquals("nothing left to supersede", emptyList<Long>(), ledger.realPosted(g, 1))
    }

    @Test
    fun `a real post BEFORE the refusal covers it, so no generic banner is added next to it`() {
        val ledger = GenericBannerLedger()
        ledger.pushQueued(g)
        assertEquals("no generic yet to replace", emptyList<Long>(), ledger.realPosted(g, 1))
        assertTrue(ledger.refusedCoveredByRealPost(g))
        assertFalse("the credit is spent once", ledger.refusedCoveredByRealPost(g))
    }

    @Test
    fun `a real post with no push in flight leaves no CREDIT, only one unclaimed note`() {
        val ledger = GenericBannerLedger()
        // The ACK won the race: no push was in flight for this message.
        assertEquals(emptyList<Long>(), ledger.realPosted(g, 1))
        // A push queued afterwards is covered by the unclaimed note only if it is REFUSED for good
        // (the caller asks only then): the note is one, and spent once.
        ledger.pushQueued(g)
        assertTrue(ledger.refusedCoveredByRealPost(g))
        assertFalse("the note is spent once", ledger.refusedCoveredByRealPost(g))
    }

    @Test
    fun `the Mi 9T 2026-10-07 case - five real banners while the push channel was cut, then three refused pushes`() {
        val ledger = GenericBannerLedger()
        // Five messages, each with its OWN real banner and no push in flight.
        repeat(5) { assertEquals(emptyList<Long>(), ledger.realPosted(g, 1)) }
        // The radios return: three pushes arrive and are refused SecretReuse.
        repeat(3) { ledger.pushQueued(g) }
        repeat(3) {
            assertTrue("a refused push after real banners posts no generic line", ledger.refusedCoveredByRealPost(g))
        }
    }

    @Test
    fun `unclaimed real posts are bounded per group`() {
        val ledger = GenericBannerLedger()
        repeat(GenericBannerLedger.MAX_UNCLAIMED + 5) { ledger.realPosted(g, 1) }
        repeat(GenericBannerLedger.MAX_UNCLAIMED) { assertTrue(ledger.refusedCoveredByRealPost(g)) }
        assertFalse(ledger.refusedCoveredByRealPost(g))
    }

    @Test
    fun `a cancelled group forgets its real posts, so a later refused push still posts its line`() {
        val ledger = GenericBannerLedger()
        ledger.realPosted(g, 2)
        ledger.groupCleared(g)
        assertFalse(ledger.refusedCoveredByRealPost(g))
        ledger.realPosted(g, 1)
        ledger.realPosted("group-b", 1)
        ledger.allCleared()
        assertFalse(ledger.refusedCoveredByRealPost(g))
        assertFalse(ledger.refusedCoveredByRealPost("group-b"))
    }

    @Test
    fun `credits never outlive the pushes in flight`() {
        val ledger = GenericBannerLedger()
        ledger.pushQueued(g)
        ledger.realPosted(g, 1)
        ledger.pushFinished(g)
        ledger.pushQueued(g)
        assertFalse(ledger.refusedCoveredByRealPost(g))
    }

    @Test
    fun `groups do not share state`() {
        val ledger = GenericBannerLedger()
        ledger.pushQueued(g)
        ledger.genericPosted(g, 5L)
        assertEquals(emptyList<Long>(), ledger.realPosted("group-b", 1))
        assertEquals(listOf(5L), ledger.realPosted(g, 1))
    }

    @Test
    fun `one batched real post covers every refused push in flight, the Mi 9T case`() {
        // messages=5: one banner, three pushes refused SecretReuse (2026-10-06).
        val ledger = GenericBannerLedger()
        repeat(3) { ledger.pushQueued(g) }
        assertEquals(emptyList<Long>(), ledger.realPosted(g, 5))
        assertTrue(ledger.refusedCoveredByRealPost(g))
        assertTrue(ledger.refusedCoveredByRealPost(g))
        assertTrue(ledger.refusedCoveredByRealPost(g))
        // CREDITS are bounded by the pushes in flight (3); the 2 messages of the batch no push was
        // waiting for stay as unclaimed notes, and the sixth refusal has nothing left.
        assertTrue(ledger.refusedCoveredByRealPost(g))
        assertTrue(ledger.refusedCoveredByRealPost(g))
        assertFalse(ledger.refusedCoveredByRealPost(g))
    }

    @Test
    fun `a batched real post replaces several generic lines then credits the rest`() {
        val ledger = GenericBannerLedger()
        repeat(3) { ledger.pushQueued(g) }
        ledger.genericPosted(g, 10L)
        ledger.genericPosted(g, 20L)
        // The two pushes that posted those lines are finished; the third is still in flight.
        repeat(2) { ledger.pushFinished(g) }
        assertEquals(listOf(10L, 20L), ledger.realPosted(g, 5))
        assertTrue("the third push is still in flight and is covered by the remainder", ledger.refusedCoveredByRealPost(g))
        // 5 messages: 2 replaced a generic each, 1 a credit, 2 are unclaimed notes.
        assertTrue(ledger.refusedCoveredByRealPost(g))
        assertTrue(ledger.refusedCoveredByRealPost(g))
        assertFalse(ledger.refusedCoveredByRealPost(g))
    }

    @Test
    fun `a post covering N takes at most N generic lines`() {
        val ledger = GenericBannerLedger()
        repeat(3) { ledger.pushQueued(g) }
        ledger.genericPosted(g, 10L)
        ledger.genericPosted(g, 20L)
        ledger.genericPosted(g, 30L)
        assertEquals(listOf(10L), ledger.realPosted(g, 1))
        assertEquals(listOf(20L, 30L), ledger.realPosted(g, 2))
    }

    @Test
    fun `a batched post with no push behind it leaves unclaimed notes, not credits`() {
        val ledger = GenericBannerLedger()
        assertEquals(emptyList<Long>(), ledger.realPosted(g, 5))
        ledger.pushQueued(g)
        repeat(5) { assertTrue(ledger.refusedCoveredByRealPost(g)) }
        assertFalse(ledger.refusedCoveredByRealPost(g))
    }
}
