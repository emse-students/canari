package fr.emse.canari

import fr.emse.canari.push.ReadElsewhereMarks
import fr.emse.canari.push.ReadElsewhereMarks.Line
import fr.emse.canari.push.ReadElsewhereMarks.Read
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch

/**
 * The read-elsewhere record a post is checked against, and the lines a read is weighed against
 * ([ReadElsewhereMarks]).
 *
 * The race it closes (review of #3912, 2026-11-20): the WebView's post of a message is
 * asynchronous before it reaches Kotlin, so the read covering it can be handed over FIRST. A bare
 * cancel then removed nothing, and the post that followed put up a banner for a message already
 * read, for good. With the record, the read leaves its mark behind and the late post is refused -
 * whichever arrived first - and a refused post touches nothing at all. The read removes the banner
 * only when it covers every line this process POSTED: the WebView's row can lag behind the shade,
 * and the shade itself lags a `notify` (the system enqueues the record after the call returns).
 */
class ReadElsewhereMarksTest {

    /**
     * A conversation notification as the system holds it: ASYNCHRONOUS, as NotificationManagerService
     * is - a `notify` or a `cancel` is only queued, and the shade a reader asks shows it once the test
     * [drain]s the queue. A fake that showed a post at once would make every test pass by construction.
     */
    private class AsyncShade {
        private val visible = mutableListOf<Line>()
        private val queue = mutableListOf<() -> Unit>()
        val events: MutableList<String> = Collections.synchronizedList(mutableListOf())

        /** The shade's answer: what the system has enqueued so far, null when nothing is posted. */
        @Synchronized
        fun read(): List<Line>? = if (visible.isEmpty()) null else visible.toList()

        /** `notify` with the notification's whole set of lines, as the builder posts it. */
        @Synchronized
        fun notify(lines: List<Line>) {
            events += "notify"
            queue += { visible.clear(); visible += lines }
        }

        @Synchronized
        fun cancel() {
            events += "cancel"
            queue += { visible.clear() }
        }

        /** The system catches up. */
        @Synchronized
        fun drain() {
            queue.forEach { it() }
            queue.clear()
        }
    }

    /** The builder: posts the notification's lines (re-injected ones plus [line]) unless read. */
    private fun ReadElsewhereMarks.post(shade: AsyncShade, id: String, held: List<Line>, line: Line): Boolean {
        val lines = held + line
        return postUnlessRead(id, line.sentAt, line.serverAt, lines) { shade.notify(lines) }
    }

    private fun ReadElsewhereMarks.readOn(shade: AsyncShade, id: String, read: Read): Boolean =
        recordThenCancel(id, read, shadeLines = shade::read, cancel = shade::cancel)

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

    private val m1 = Line(sentAt = 900L, serverAt = 1_000L)
    private val m2 = Line(sentAt = 1_900L, serverAt = 2_000L)

    // Round-4 review of #3912, scenario A: the banner holds M1, M2 is posted, and a read covering
    // M1 only arrives before the system has enqueued M2. The shade still shows M1 alone; weighing it
    // cancelled the banner and lost M2.
    @Test
    fun `a read covering only the older line keeps a banner whose newer post the shade has not shown yet`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        assertTrue(marks.post(shade, "g1", emptyList(), m1))
        shade.drain()
        assertTrue(marks.post(shade, "g1", listOf(m1), m2))
        // The shade has not caught up: it still answers M1 alone.
        assertEquals(listOf(m1), shade.read())

        assertFalse(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
        shade.drain()
        assertEquals(listOf(m1, m2), shade.read())
    }

    // Scenario B: a first banner M1, then a read covering it before the system has enqueued M1.
    // The shade is still empty; weighing it cancelled nothing and M1 stood after being read.
    @Test
    fun `a read covering a first banner the shade has not shown yet removes it`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        assertTrue(marks.post(shade, "g1", emptyList(), m1))
        assertNull(shade.read())

        assertTrue(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
        shade.drain()
        assertNull(shade.read())
        assertEquals(listOf("notify", "cancel"), shade.events)
    }

    @Test
    fun `a fresh process with nothing posted weighs the shade an earlier one left`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        shade.notify(listOf(m1, m2))
        shade.drain()
        assertFalse(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
        assertTrue(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        shade.drain()
        assertNull(shade.read())
    }

    @Test
    fun `once cancelled the record is dropped, and the shade answers again`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        marks.post(shade, "g1", emptyList(), m1)
        assertTrue(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
        shade.drain()
        // Nothing posted by this process, nothing in the shade: nothing to cancel.
        assertFalse(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
    }

    @Test
    fun `a banner removed another way is forgotten`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        marks.post(shade, "g1", emptyList(), m2)
        marks.forget("g1")
        shade.cancel()
        shade.drain()
        assertFalse(marks.readOn(shade, "g1", Read(500L, serverClock = true)))
    }

    // Round-3 review of #3912 (B1): the WebView is frozen, the account reads on desktop at t1, a peer
    // sends N at t2 > t1 and the push posts N. On thaw the own read t1 is drained before N reaches the
    // row, which then counts nothing unread. The lines hold N: the read must leave it standing.
    @Test
    fun `a mark older than the newest line cancels nothing`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        marks.post(shade, "g1", emptyList(), m1)
        marks.post(shade, "g1", listOf(m1), m2)
        shade.drain()
        assertFalse(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
        assertFalse("cancel" in shade.events)
    }

    @Test
    fun `a mark covering every line cancels`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        marks.post(shade, "g1", emptyList(), m1)
        marks.post(shade, "g1", listOf(m1), m2)
        assertTrue(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        shade.drain()
        assertNull(shade.read())
    }

    @Test
    fun `a line comparable on neither clock keeps the banner`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        // A stamped-only line against a server-clock mark: not provably read.
        marks.post(shade, "g1", emptyList(), Line(sentAt = 500L, serverAt = 0L))
        assertFalse(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        // The stamped clock, once known, settles it.
        assertTrue(marks.readOn(shade, "g1", Read(600L, serverClock = false)))
    }

    // Round-4 review, minor 1: a banner from the previous build carries no stamps. Dropping its lines
    // made it count as covered, so the first read after the upgrade cancelled whatever it held.
    @Test
    fun `an unstamped line from someone else is never covered, an own line is not news`() {
        assertEquals(Line(0L, 0L), Line.of(fromSelf = false, sentAt = null, serverAt = null))
        assertNull(Line.of(fromSelf = true, sentAt = null, serverAt = null))
        assertEquals(Line(5L, 0L), Line.of(fromSelf = false, sentAt = 5L, serverAt = null))

        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        shade.notify(listOfNotNull(Line.of(fromSelf = false, sentAt = null, serverAt = null)))
        shade.drain()
        assertFalse(marks.readOn(shade, "g1", Read(Long.MAX_VALUE, serverClock = true)))
        assertFalse(marks.readOn(shade, "g1", Read(Long.MAX_VALUE, serverClock = false)))

        // A banner holding only this account's own line is covered.
        var cancelled = false
        assertTrue(
            marks.recordThenCancel("g2", Read(1L, serverClock = true), shadeLines = { emptyList() }, cancel = { cancelled = true }),
        )
        assertTrue(cancelled)
    }

    @Test
    fun `a post that resolves after the read is covered and is not posted`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        assertFalse(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        assertFalse(marks.post(shade, "g1", emptyList(), Line(sentAt = 1_990L, serverAt = 2_000L)))
        assertTrue(shade.events.isEmpty())
    }

    // Re-review of #3912 (B1 of round 2): the channel switch removed the conversation's CURRENT
    // banner before the read-elsewhere check. Every side effect of the post is now one step, run
    // only when the post is not covered.
    @Test
    fun `a covered post runs none of its side effects - not even the channel-switch cancel`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", Read(2_000L, serverClock = true))
        val steps = mutableListOf<String>()
        val posted = marks.postUnlessRead("g1", sentAt = 1_000L, serverAt = 1_500L, lines = emptyList()) {
            steps += "cancel previous banner"
            steps += "notify"
        }
        assertFalse(posted)
        assertTrue(steps.isEmpty())
    }

    @Test
    fun `a read that keeps the banner still refuses an older late post`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        marks.post(shade, "g1", emptyList(), Line(sentAt = 2_900L, serverAt = 3_000L))
        assertFalse(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        assertFalse(marks.post(shade, "g1", emptyList(), Line(sentAt = 1_900L, serverAt = 1_950L)))
        assertTrue(marks.post(shade, "g1", emptyList(), Line(sentAt = 3_500L, serverAt = 3_600L)))
    }

    /**
     * THE INTERLEAVING: a post that has passed its check and is inside its side effects when the
     * read arrives. The read must wait for the post to finish, then weigh its line and cancel it.
     * Ordered by latches and the reader thread's own state, never by a clock.
     */
    @Test
    fun `a read arriving while a post is in flight waits for it, then removes it`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        val inPost = CountDownLatch(1)
        val releasePost = CountDownLatch(1)
        val line = Line(sentAt = 1_000L, serverAt = 1_000L)

        val poster = Thread({
            marks.postUnlessRead("g1", line.sentAt, line.serverAt, listOf(line)) {
                inPost.countDown()
                releasePost.await()
                shade.notify(listOf(line))
            }
        }, "poster")
        poster.start()
        inPost.await()

        val reader = Thread({ marks.readOn(shade, "g1", Read(1_000L, serverClock = true)) }, "reader")
        reader.start()
        // The reader is parked on the lock the post holds: nothing it does can land yet.
        awaitBlocked(reader)
        assertTrue(shade.events.isEmpty())

        releasePost.countDown()
        poster.join()
        reader.join()
        assertEquals(listOf("notify", "cancel"), shade.events)
    }

    @Test
    fun `a post arriving while a read is in flight waits for it, then is refused`() {
        val marks = ReadElsewhereMarks()
        val shade = AsyncShade()
        marks.post(shade, "g1", emptyList(), Line(sentAt = 500L, serverAt = 500L))
        shade.events.clear()
        val inRead = CountDownLatch(1)
        val releaseRead = CountDownLatch(1)

        val reader = Thread({
            marks.recordThenCancel(
                "g1",
                Read(1_000L, serverClock = true),
                shadeLines = shade::read,
                cancel = {
                    inRead.countDown()
                    releaseRead.await()
                    shade.cancel()
                },
            )
        }, "reader")
        reader.start()
        inRead.await()

        var posted = true
        val poster = Thread({ posted = marks.post(shade, "g1", emptyList(), Line(1_000L, 1_000L)) }, "poster")
        poster.start()
        awaitBlocked(poster)

        releaseRead.countDown()
        reader.join()
        poster.join()
        assertFalse(posted)
        assertEquals(listOf("cancel"), shade.events)
    }

    @Test
    fun `another conversation is untouched`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", Read(2_000L, serverClock = true))
        assertFalse(marks.covers("g2", sentAt = 1L, serverAt = 1L))
        assertNull(marks.of("g2"))
    }

    @Test
    fun `the server clock decides when both sides carry it, the stamped one otherwise`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", Read(5_000L, serverClock = false))
        marks.record("g1", Read(2_000L, serverClock = true))
        assertFalse(marks.covers("g1", sentAt = 1_000L, serverAt = 3_000L))
        assertTrue(marks.covers("g1", sentAt = 4_000L, serverAt = 0L))
        marks.record("channel_c1", Read(300L, serverClock = false))
        assertTrue(marks.covers("channel_c1", sentAt = 300L, serverAt = 900L))
        assertFalse(marks.covers("channel_c1", sentAt = 301L, serverAt = 100L))
    }

    @Test
    fun `a message comparable on neither clock is posted - a lost banner is a lost message`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", Read(2_000L, serverClock = true))
        assertFalse(marks.covers("g1", sentAt = 1_000L, serverAt = 0L))
    }

    @Test
    fun `a mark only rises, and an empty id or a non-positive instant records nothing`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", Read(2_000L, serverClock = true))
        marks.record("g1", Read(1_000L, serverClock = true))
        marks.record("g1", Read(0L, serverClock = false))
        marks.record("", Read(9_000L, serverClock = true))
        assertEquals(ReadElsewhereMarks.Mark(stamped = 0L, server = 2_000L), marks.of("g1"))
        assertNull(marks.of(""))
    }
}
