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
 * The read-elsewhere record a post is checked against, and the shade a read is weighed against
 * ([ReadElsewhereMarks]).
 *
 * The race it closes (review of #3912, 2026-11-20): the WebView's post of a message is
 * asynchronous before it reaches Kotlin, so the read covering it can be handed over FIRST. A bare
 * cancel then removed nothing, and the post that followed put up a banner for a message already
 * read, for good. With the record, the read leaves its mark behind and the late post is refused -
 * whichever arrived first - and a refused post touches nothing at all. And the read removes the
 * banner only when it covers every line the shade holds: the WebView's row, which used to decide,
 * can lag behind the shade.
 */
class ReadElsewhereMarksTest {

    /** A conversation notification as the native side sees it: the lines it holds, in order. */
    private class FakeShade {
        val lines: MutableList<Line> = Collections.synchronizedList(mutableListOf())
        val events: MutableList<String> = Collections.synchronizedList(mutableListOf())

        /** null when nothing is posted, as the real lookup answers. */
        fun read(): List<Line>? = synchronized(lines) { if (lines.isEmpty()) null else lines.toList() }

        fun post(line: Line) {
            lines += line
            events += "notify"
        }

        fun cancel() {
            lines.clear()
            events += "cancel"
        }
    }

    private fun ReadElsewhereMarks.readOn(shade: FakeShade, id: String, read: Read): Boolean =
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

    @Test
    fun `a post that resolves after the read is covered and is not posted`() {
        val marks = ReadElsewhereMarks()
        val shade = FakeShade()
        // The read lands first, on an empty shade...
        assertFalse(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        // ...then the post of the message it read arrives.
        val line = Line(sentAt = 1_990L, serverAt = 2_000L)
        assertFalse(marks.postUnlessRead("g1", line.sentAt, line.serverAt) { shade.post(line) })
        assertTrue(shade.events.isEmpty())
    }

    // Round-3 review of #3912 (B1): the WebView is frozen, the account reads on desktop at t1, a peer
    // sends N at t2 > t1 and the push posts N. On thaw the own read t1 is drained before N reaches the
    // row, which then counts nothing unread. The shade holds N: the read must leave it standing.
    @Test
    fun `a mark older than the shade's newest line cancels nothing`() {
        val marks = ReadElsewhereMarks()
        val shade = FakeShade()
        shade.post(Line(sentAt = 900L, serverAt = 1_000L))
        shade.post(Line(sentAt = 1_900L, serverAt = 2_000L))
        assertFalse(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
        assertEquals(2, shade.lines.size)
        assertFalse("cancel" in shade.events)
    }

    @Test
    fun `a mark covering every line cancels`() {
        val marks = ReadElsewhereMarks()
        val shade = FakeShade()
        shade.post(Line(sentAt = 900L, serverAt = 1_000L))
        shade.post(Line(sentAt = 1_900L, serverAt = 2_000L))
        assertTrue(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        assertNull(shade.read())
    }

    @Test
    fun `a line comparable on neither clock keeps the banner`() {
        val marks = ReadElsewhereMarks()
        val shade = FakeShade()
        // A stamped-only line against a server-clock mark: not provably read.
        shade.post(Line(sentAt = 500L, serverAt = 0L))
        assertFalse(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        // The stamped clock, once known, settles it.
        assertTrue(marks.readOn(shade, "g1", Read(600L, serverClock = false)))
    }

    @Test
    fun `a notification with no stamped line is covered`() {
        val marks = ReadElsewhereMarks()
        var cancelled = false
        val ran = marks.recordThenCancel(
            "g1", Read(2_000L, serverClock = true), shadeLines = { emptyList() }, cancel = { cancelled = true },
        )
        assertTrue(ran)
        assertTrue(cancelled)
    }

    // Re-review of #3912 (B1 of round 2): the channel switch removed the conversation's CURRENT
    // banner before the read-elsewhere check, so a covered late post (an older mention) took a newer
    // message's banner down and posted nothing. Every side effect of the post is now one step, run
    // only when the post is not covered.
    @Test
    fun `a covered post runs none of its side effects - not even the channel-switch cancel`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", Read(2_000L, serverClock = true))
        val steps = mutableListOf<String>()
        val posted = marks.postUnlessRead("g1", sentAt = 1_000L, serverAt = 1_500L) {
            steps += "cancel previous banner"
            steps += "notify"
        }
        assertFalse(posted)
        assertTrue(steps.isEmpty())
    }

    @Test
    fun `a message newer than the mark is posted, every step in order`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", Read(2_000L, serverClock = true))
        val steps = mutableListOf<String>()
        val posted = marks.postUnlessRead("g1", sentAt = 2_100L, serverAt = 2_001L) {
            steps += "cancel previous banner"
            steps += "notify"
        }
        assertTrue(posted)
        assertEquals(listOf("cancel previous banner", "notify"), steps)
    }

    @Test
    fun `a read that keeps the banner still refuses an older late post`() {
        val marks = ReadElsewhereMarks()
        val shade = FakeShade()
        shade.post(Line(sentAt = 2_900L, serverAt = 3_000L))
        assertFalse(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        assertFalse(marks.postUnlessRead("g1", sentAt = 1_900L, serverAt = 1_950L) {})
        assertTrue(marks.postUnlessRead("g1", sentAt = 3_500L, serverAt = 3_600L) {})
    }

    /**
     * THE INTERLEAVING: a post that has passed its check and is inside its side effects when the
     * read arrives. The read must wait for the post to finish, then weigh its line and cancel it -
     * never decide first and let the post land after. Ordered by latches and the reader thread's
     * own state, never by a clock.
     */
    @Test
    fun `a read arriving while a post is in flight waits for it, then removes it`() {
        val marks = ReadElsewhereMarks()
        val shade = FakeShade()
        val inPost = CountDownLatch(1)
        val releasePost = CountDownLatch(1)
        val line = Line(sentAt = 1_000L, serverAt = 1_000L)

        val poster = Thread({
            marks.postUnlessRead("g1", line.sentAt, line.serverAt) {
                inPost.countDown()
                releasePost.await()
                shade.post(line)
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
        val shade = FakeShade()
        shade.post(Line(sentAt = 500L, serverAt = 500L))
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
        val line = Line(sentAt = 1_000L, serverAt = 1_000L)
        val poster = Thread({ posted = marks.postUnlessRead("g1", line.sentAt, line.serverAt) { shade.post(line) } }, "poster")
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
        // Server clocks compared: 3_000 is above the server mark, whatever the sender stamped.
        assertFalse(marks.covers("g1", sentAt = 1_000L, serverAt = 3_000L))
        // No server instant on the message: the stamped clock answers.
        assertTrue(marks.covers("g1", sentAt = 4_000L, serverAt = 0L))
        // A salon mark is stamped only: a message with both clocks is read on the stamped one.
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
