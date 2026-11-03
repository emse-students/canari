package fr.emse.canari

import fr.emse.canari.push.WakeOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.RejectedExecutionException

/**
 * The arrival-order buffer in front of the MLS lane: wake fetches settle in any order, full pushes
 * need none, the lane sees all of them in the order they arrived - and no push waits longer than one
 * deadline after the latest wake ahead of it arrived. Time is a recorder fired by hand: no wall clock.
 */
class WakeOrderTest {

    private val deadline = 20_000L

    /** The deadlines [WakeOrder.arrive] scheduled, in order, with the delay each asked for. */
    private val scheduled = mutableListOf<Pair<Long, () -> Unit>>()
    private val order = WakeOrder(deadline) { delay, task -> scheduled += delay to task }

    /** A stand-in for the lane: what it was handed, in order. */
    private val lane = mutableListOf<String>()

    private fun fireDeadlines() = scheduled.toList().forEach { (_, task) -> task() }

    @Test
    fun `a later fetch that returns first waits for the earlier one`() {
        val a = order.arrive { lane += "a-deadline" }
        val b = order.arrive { lane += "b-deadline" }
        val c = order.arrive { lane += "c-deadline" }
        assertEquals(0, order.settle(c) { lane += "c" })
        assertEquals(0, order.settle(b) { lane += "b" })
        assertEquals(emptyList<String>(), lane)
        assertEquals(3, order.settle(a) { lane += "a" })
        assertEquals(listOf("a", "b", "c"), lane)
        assertEquals(0L, order.waiting())
    }

    @Test
    fun `a full push arriving after a wake still out waits for it - the Welcome joins before the salon opens`() {
        // A key-group Welcome arrives as a wake; its fetch is out.
        val welcome = order.arrive { lane += "not-loaded" }
        // The salon push sealed on that key group arrives FULL, and must not overtake it (NOTIF-21).
        assertFalse(order.inOrder { lane += "channel" })
        assertEquals(emptyList<String>(), lane)
        // The Welcome's fetch returns; its dispatch queues the join from inside the release.
        order.settle(welcome) { order.inOrder { lane += "welcome-join" } }
        assertEquals(listOf("welcome-join", "channel"), lane)
    }

    @Test
    fun `a wake that arrives after a full push does not hold it`() {
        assertTrue(order.inOrder { lane += "full" })
        val wake = order.arrive { lane += "deadline" }
        order.settle(wake) { lane += "wake" }
        assertEquals(listOf("full", "wake"), lane)
    }

    @Test
    fun `a failed fetch settles its ticket like any other, so nothing behind it stalls`() {
        val failed = order.arrive { lane += "deadline" }
        order.inOrder { lane += "after" }
        order.settle(failed) { lane += "not-loaded" }
        assertEquals(listOf("not-loaded", "after"), lane)
        assertEquals(0L, order.waiting())
    }

    @Test
    fun `every wake's deadline is scheduled at ARRIVAL, for the whole bound`() {
        repeat(5) { order.arrive {} }
        assertEquals(List(5) { deadline }, scheduled.map { it.first })
    }

    @Test
    fun `N stalled wakes hold a full push for one deadline, not N fetch timeouts`() {
        // Ten wakes arrive and none of their fetches ever returns (four fetch threads, all stuck).
        val wakes = List(10) { i -> order.arrive { lane += "deadline-$i" } }
        assertFalse(order.inOrder { lane += "full" })
        // One deadline after the LAST of them arrived, every one of them has been settled, so the
        // full push is on the lane - every deadline was scheduled at arrival, none waited for a fetch.
        fireDeadlines()
        assertEquals(List(10) { "deadline-$it" } + "full", lane)
        assertEquals(0L, order.waiting())
        // A fetch that comes back afterwards is dropped, not run.
        assertNull(order.settle(wakes[3]) { lane += "late" })
        assertEquals(11, lane.size)
    }

    @Test
    fun `a settled ticket ignores its deadline`() {
        val wake = order.arrive { lane += "deadline" }
        order.settle(wake) { lane += "fetched" }
        fireDeadlines()
        assertEquals(listOf("fetched"), lane)
    }

    @Test
    fun `a deadline that cannot be scheduled settles the ticket at once, so nothing behind it is stranded`() {
        val refusing = WakeOrder(deadline) { _, _ -> throw RejectedExecutionException("shut down") }
        val reasons = mutableListOf<String>()
        val wake = refusing.arrive(onScheduleFailed = { reasons += it.javaClass.simpleName }) { lane += "not-loaded" }
        assertEquals(listOf("RejectedExecutionException"), reasons)
        assertEquals(listOf("not-loaded"), lane)
        assertTrue(refusing.inOrder { lane += "after" })
        assertEquals(listOf("not-loaded", "after"), lane)
        // The fetch that comes back later finds its ticket settled.
        assertNull(refusing.settle(wake) { lane += "late" })
    }

    @Test
    fun `in one release batch every action runs before any hand-off - the Welcome is counted before the lane runs the frame`() {
        val wake = order.arrive {}
        // Released in the same batch: the frame (counted nothing) then the Welcome (counts its group).
        order.inOrder { lane += "frame:counted"; order.handOff { lane += "frame:on-lane" } }
        order.inOrder { lane += "welcome:counted"; order.handOff { lane += "welcome:on-lane" } }
        order.settle(wake) { lane += "wake:counted"; order.handOff { lane += "wake:on-lane" } }
        assertEquals(
            listOf(
                "wake:counted", "frame:counted", "welcome:counted",
                "wake:on-lane", "frame:on-lane", "welcome:on-lane",
            ),
            lane,
        )
    }

    @Test
    fun `outside a release a hand-off goes at once`() {
        order.handOff { lane += "requeue" }
        assertEquals(listOf("requeue"), lane)
    }

    @Test
    fun `a full push with nothing earlier out goes at once`() {
        assertTrue(order.inOrder { lane += "commit" })
        assertTrue(order.inOrder { lane += "message" })
        assertEquals(listOf("commit", "message"), lane)
        assertEquals(0L, order.waiting())
    }

    @Test
    fun `an action that throws does not strand the ones released behind it`() {
        val first = order.arrive {}
        order.inOrder { lane += "behind" }
        assertThrows(IllegalStateException::class.java) {
            order.settle(first) { throw IllegalStateException("boom") }
        }
        assertEquals(listOf("behind"), lane)
        assertEquals(0L, order.waiting())
    }

    @Test
    fun `a ticket never handed out is refused`() {
        assertThrows(IllegalArgumentException::class.java) { order.settle(5) {} }
    }
}
