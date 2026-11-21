package fr.emse.canari

import fr.emse.canari.push.AwaitedReplies
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CountDownLatch

/**
 * How a quick reply's handler learns that ANOTHER drain delivered its reply ([AwaitedReplies]) -
 * decided by the outbox lock's order, never by thread scheduling (round-10 review of #3912).
 */
class AwaitedRepliesTest {

    /** The outbox lock, as the service holds it around a drain. */
    private val outboxLock = Any()

    /**
     * Waits until [thread] is parked on a monitor - BOUNDED BY A SPIN COUNT, never a clock, so a lock
     * that stopped excluding fails the test instead of hanging the build.
     */
    private fun awaitBlocked(thread: Thread) {
        repeat(50_000_000) {
            if (thread.state == Thread.State.BLOCKED) return
            if (thread.state == Thread.State.TERMINATED) fail("${thread.name} ran to the end - nothing excluded it")
            Thread.yield()
        }
        fail("${thread.name} never blocked on the lock")
    }

    // The interleaving measured on the Mi 9T: the retry worker W holds the outbox lock and POSTs r1;
    // the handler H waits on it, its drain then finds r1 gone. W's post-lock step has NOT run yet -
    // H must still see the delivery, because W recorded it at the send, under the outbox lock.
    @Test
    fun `a delivery by another drain is seen by the handler's check before that drain's late step`() {
        val replies = AwaitedReplies()
        replies.await("r1")
        val wPosting = CountDownLatch(1)
        val releaseW = CountDownLatch(1)
        val lateStepMayRun = CountDownLatch(1)
        var seenByHandler: Long? = null
        val worker = Thread({
            synchronized(outboxLock) {
                wPosting.countDown()
                releaseW.await()
                replies.delivered("r1", 4_200L) // at the send, still under the outbox lock
            }
            lateStepMayRun.await() // its post-lock `replyDelivered` - held back on purpose
        }, "worker")
        worker.start()
        wPosting.await()
        val handler = Thread({
            synchronized(outboxLock) { /* its own drain: r1 is no longer queued */ }
            seenByHandler = replies.deliveredAt("r1")
        }, "handler")
        handler.start()
        awaitBlocked(handler)
        releaseW.countDown()
        handler.join()
        assertEquals(4_200L, seenByHandler)
        lateStepMayRun.countDown()
        worker.join()
    }

    @Test
    fun `only an awaited reply is recorded, and only until its handler ends`() {
        val replies = AwaitedReplies()
        repeat(1_000) { i -> replies.delivered("m$i", 1L) }
        assertNull(replies.deliveredAt("m0"))
        replies.await("r1")
        assertNull(replies.deliveredAt("r1"))
        replies.delivered("r1", 7L)
        assertEquals(7L, replies.deliveredAt("r1"))
        replies.settle("r1")
        assertNull(replies.deliveredAt("r1"))
        replies.delivered("r1", 8L)
        assertNull(replies.deliveredAt("r1"))
    }
}
