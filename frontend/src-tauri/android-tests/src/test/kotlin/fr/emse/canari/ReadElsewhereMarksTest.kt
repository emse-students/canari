package fr.emse.canari

import fr.emse.canari.push.ReadElsewhereMarks
import fr.emse.canari.push.ReadElsewhereMarks.Read
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch

/**
 * The read-elsewhere record a post is checked against ([ReadElsewhereMarks]).
 *
 * The race it closes (review of #3912, 2026-11-20): the WebView's post of a message is
 * asynchronous before it reaches Kotlin, so the read covering it can be handed over FIRST. A bare
 * cancel then removed nothing, and the post that followed put up a banner for a message already
 * read, for good. With the record, the dismissal leaves the mark behind and the late post is
 * refused - whichever arrived first - and a refused post touches nothing at all.
 */
class ReadElsewhereMarksTest {

    @Test
    fun `a post that resolves after the dismissal is covered and is not posted`() {
        val marks = ReadElsewhereMarks()
        val shade = mutableListOf<String>()
        // The dismissal lands first...
        marks.recordThenCancel("g1", Read(2_000L, serverClock = true)) { shade += "cancel" }
        // ...then the post of the message it read arrives.
        val posted = marks.postUnlessRead("g1", sentAt = 1_990L, serverAt = 2_000L) { shade += "notify" }
        assertFalse(posted)
        assertEquals(listOf("cancel"), shade)
    }

    // Re-review of #3912 (B1): the channel switch removed the conversation's CURRENT banner before
    // the read-elsewhere check, so a covered late post (an older mention) took a newer message's
    // banner down and posted nothing. Every side effect of the post is now one step, run only
    // when the post is not covered.
    @Test
    fun `a covered post runs none of its side effects - not even the channel-switch cancel`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", Read(2_000L, serverClock = true))
        val shade = mutableListOf<String>()
        val posted = marks.postUnlessRead("g1", sentAt = 1_000L, serverAt = 1_500L) {
            shade += "cancel previous banner"
            shade += "notify"
        }
        assertFalse(posted)
        assertTrue(shade.isEmpty())
    }

    @Test
    fun `a message newer than the mark is posted, every step in order`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", Read(2_000L, serverClock = true))
        val shade = mutableListOf<String>()
        val posted = marks.postUnlessRead("g1", sentAt = 2_100L, serverAt = 2_001L) {
            shade += "cancel previous banner"
            shade += "notify"
        }
        assertTrue(posted)
        assertEquals(listOf("cancel previous banner", "notify"), shade)
    }

    // Re-review of #3912 (N1): a read that leaves a newer message unread dismisses nothing, but its
    // mark is recorded all the same, so the late post of an older message is still refused.
    @Test
    fun `a mark recorded without a cancel still refuses an older post and lets a newer one through`() {
        val marks = ReadElsewhereMarks()
        marks.record("g1", Read(2_000L, serverClock = true))
        assertFalse(marks.postUnlessRead("g1", sentAt = 1_900L, serverAt = 1_950L) {})
        assertTrue(marks.postUnlessRead("g1", sentAt = 2_500L, serverAt = 2_600L) {})
    }

    /**
     * THE INTERLEAVING (N3): a post that has passed its check and is inside its side effects when
     * the read arrives. The read must wait for the post to finish, then cancel it - never cancel
     * first and let the post land after. Ordered by latches and the reader thread's own state,
     * never by a clock.
     */
    @Test
    fun `a read arriving while a post is in flight waits for it, then removes it`() {
        val marks = ReadElsewhereMarks()
        val shade = Collections.synchronizedList(mutableListOf<String>())
        val inPost = CountDownLatch(1)
        val releasePost = CountDownLatch(1)

        val poster = Thread {
            marks.postUnlessRead("g1", sentAt = 1_000L, serverAt = 1_000L) {
                inPost.countDown()
                releasePost.await()
                shade += "notify"
            }
        }
        poster.start()
        inPost.await()

        val reader = Thread {
            marks.recordThenCancel("g1", Read(1_000L, serverClock = true)) { shade += "cancel" }
        }
        reader.start()
        // The reader is parked on the lock the post holds: nothing it does can land yet.
        while (reader.state != Thread.State.BLOCKED) Thread.yield()
        assertTrue(shade.isEmpty())

        releasePost.countDown()
        poster.join()
        reader.join()
        assertEquals(listOf("notify", "cancel"), shade)
    }

    @Test
    fun `a post arriving while a read is in flight waits for it, then is refused`() {
        val marks = ReadElsewhereMarks()
        val shade = Collections.synchronizedList(mutableListOf<String>())
        val inRead = CountDownLatch(1)
        val releaseRead = CountDownLatch(1)

        val reader = Thread {
            marks.recordThenCancel("g1", Read(1_000L, serverClock = true)) {
                inRead.countDown()
                releaseRead.await()
                shade += "cancel"
            }
        }
        reader.start()
        inRead.await()

        var posted = true
        val poster = Thread {
            posted = marks.postUnlessRead("g1", sentAt = 1_000L, serverAt = 1_000L) { shade += "notify" }
        }
        poster.start()
        while (poster.state != Thread.State.BLOCKED) Thread.yield()

        releaseRead.countDown()
        reader.join()
        poster.join()
        assertFalse(posted)
        assertEquals(listOf("cancel"), shade)
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
