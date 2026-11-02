package fr.emse.canari

import fr.emse.canari.push.WakeOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The arrival-order buffer in front of the MLS lane: wake fetches complete in any order, full pushes
 * need none, and the lane sees all of them in the order they arrived.
 */
class WakeOrderTest {

    /** A stand-in for the lane: what it was handed, in order. */
    private val lane = mutableListOf<String>()
    private val toLane: (() -> Unit) -> Unit = { it() }

    @Test
    fun `a later fetch that returns first waits for the earlier one`() {
        val order = WakeOrder()
        val a = order.take()
        val b = order.take()
        val c = order.take()
        assertEquals(0, order.complete(c, { lane += "c" }, toLane))
        assertEquals(0, order.complete(b, { lane += "b" }, toLane))
        assertEquals(emptyList<String>(), lane)
        assertEquals(3, order.complete(a, { lane += "a" }, toLane))
        assertEquals(listOf("a", "b", "c"), lane)
        assertEquals(0L, order.waiting())
    }

    @Test
    fun `a full push arriving after a wake still out waits for it - the Welcome joins before the salon opens`() {
        val order = WakeOrder()
        // A key-group Welcome arrives as a wake; its fetch is out.
        val welcome = order.take()
        // The salon push sealed on that key group arrives FULL, and must not overtake it (NOTIF-21).
        assertFalse(order.inOrder({ lane += "channel" }, toLane))
        assertEquals(emptyList<String>(), lane)
        // The Welcome's fetch returns; its dispatch queues the join from inside the release.
        order.complete(welcome, { order.inOrder({ lane += "welcome-join" }, toLane) }, toLane)
        assertEquals(listOf("welcome-join", "channel"), lane)
    }

    @Test
    fun `a full push with nothing earlier out goes at once`() {
        val order = WakeOrder()
        assertTrue(order.inOrder({ lane += "commit" }, toLane))
        assertTrue(order.inOrder({ lane += "message" }, toLane))
        assertEquals(listOf("commit", "message"), lane)
        assertEquals(0L, order.waiting())
    }

    @Test
    fun `a wake that arrives after a full push does not hold it`() {
        val order = WakeOrder()
        assertTrue(order.inOrder({ lane += "full" }, toLane))
        val wake = order.take()
        order.complete(wake, { lane += "wake" }, toLane)
        assertEquals(listOf("full", "wake"), lane)
    }

    @Test
    fun `a failed fetch completes its ticket like any other, so nothing behind it stalls`() {
        val order = WakeOrder()
        val failed = order.take()
        order.inOrder({ lane += "after" }, toLane)
        // The fetch could not even be scheduled: the arrival thread completes the ticket itself.
        order.complete(failed, { lane += "not-loaded" }, toLane)
        assertEquals(listOf("not-loaded", "after"), lane)
        assertEquals(0L, order.waiting())
    }

    @Test
    fun `an action that throws does not strand the ones released behind it`() {
        val order = WakeOrder()
        val first = order.take()
        order.inOrder({ lane += "behind" }, toLane)
        assertThrows(IllegalStateException::class.java) {
            order.complete(first, { throw IllegalStateException("boom") }, toLane)
        }
        assertEquals(listOf("behind"), lane)
        assertEquals(0L, order.waiting())
    }

    @Test
    fun `a ticket cannot complete twice or before it is handed out`() {
        val order = WakeOrder()
        val t = order.take()
        order.take()
        order.complete(t + 1, {}, toLane)
        assertThrows(IllegalArgumentException::class.java) { order.complete(t + 1, {}, toLane) }
        assertThrows(IllegalArgumentException::class.java) { order.complete(t + 5, {}, toLane) }
    }
}
