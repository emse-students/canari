package fr.emse.canari

import fr.emse.canari.push.ReadElsewhereMarks
import fr.emse.canari.push.ReadElsewhereMarks.Banner
import fr.emse.canari.push.ReadElsewhereMarks.Delivery
import fr.emse.canari.push.ReadElsewhereMarks.Line
import fr.emse.canari.push.ReadElsewhereMarks.Read
import fr.emse.canari.push.ReadElsewhereMarks.Withdrawal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Collections
import java.util.concurrent.CountDownLatch

/**
 * The read-elsewhere record a post is checked against, and the banner a read is weighed against
 * ([ReadElsewhereMarks]) - driven the way the service drives it, on a shade that is ASYNCHRONOUS like
 * the system's.
 *
 * The races it closes (review of #3912, 2026-11-20): the WebView's post of a message can reach Kotlin
 * after the read covering it; the WebView's row can lag behind the shade; and the shade itself lags a
 * `notify`, which only queues the record. A read removes the banner only when it covers every line
 * this process POSTED, a post builds on what this process posted, and the order of arrival decides
 * nothing.
 */
class ReadElsewhereMarksTest {

    /** A message line as the builder stamps it: the sender's and server's instants, or none; a pending reply or not. */
    private data class Msg(val sentAt: Long?, val serverAt: Long?, val pendingReply: Boolean = false, val replyId: String? = null)

    private fun marks() = ReadElsewhereMarks<Msg> { Line.of(it.pendingReply, it.sentAt, it.serverAt, it.replyId) }

    /**
     * The system's notification list for one conversation: a `notify` or a `cancel` only QUEUES, as
     * NotificationManagerService does, and what a reader sees changes when the test [drain]s.
     */
    private class AsyncShade {
        private var visible: Banner<Msg>? = null
        private val queue = mutableListOf<() -> Unit>()
        val events: MutableList<String> = Collections.synchronizedList(mutableListOf())

        @Synchronized fun read(): Banner<Msg>? = visible

        @Synchronized fun notify(banner: Banner<Msg>) {
            events += "notify ${banner.notifId}"
            queue += { visible = banner }
        }

        @Synchronized fun cancel(notifId: Int) {
            events += "cancel $notifId"
            queue += { if (visible?.notifId == notifId) visible = null }
        }

        @Synchronized fun drain() {
            queue.forEach { it() }
            queue.clear()
        }
    }

    /**
     * The builder's section, as `showMessageNotification` runs it: under the lock, build on the
     * banner (this process's record, else the shade), then post unless read and record.
     */
    private fun ReadElsewhereMarks<Msg>.post(shade: AsyncShade, id: String, notifId: Int, msg: Msg): Boolean =
        synchronized(lock) {
            val held = bannerOf(id) { shade.read() }
            val banner = Banner(notifId, "messages", held?.messages.orEmpty() + msg)
            postUnlessRead(id, msg.sentAt ?: 0L, msg.serverAt ?: 0L, banner) { shade.notify(banner) }
        }

    /** The cancel glue, as `cancelConversationNotification` runs it. */
    private fun ReadElsewhereMarks<Msg>.readOn(shade: AsyncShade, id: String, read: Read): Boolean =
        recordThenCancel(id, read, shade = { shade.read() }, cancel = { shade.cancel(it) })

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

    private val m1 = Msg(sentAt = 900L, serverAt = 1_000L)
    private val m2 = Msg(sentAt = 1_900L, serverAt = 2_000L)

    // Round-5 review of #3912 (BLOCKER 1): the id was resolved only on the shade's branch, so the
    // normal case - this process posted the banner - cancelled id -1 and left a read banner standing.
    @Test
    fun `the cancel gets the posted banner's id when this process posted it`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", notifId = 1001, msg = m1)
        val cancelled = mutableListOf<Int>()
        assertTrue(marks.recordThenCancel("g1", Read(1_000L, serverClock = true), shade = { fail("the record answers"); null }) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
    }

    @Test
    fun `the cancel gets the shade's id in a fresh process`() {
        val marks = marks()
        val cancelled = mutableListOf<Int>()
        val shown = Banner(77, "messages", listOf(m1))
        assertTrue(marks.recordThenCancel("g1", Read(1_000L, serverClock = true), shade = { shown }) { cancelled += it })
        assertEquals(listOf(77), cancelled)
    }

    // Round-5 review (P2): re-injecting from the lagging shade, a second post right after the first
    // built on an empty shade and dropped the first one's line.
    @Test
    fun `two posts back to back keep both lines although the shade has shown neither`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, m1)
        marks.post(shade, "g1", 1001, m2)
        shade.drain()
        assertEquals(listOf(m1, m2), shade.read()?.messages)
    }

    // Round-4 review, scenario A: the banner holds M1, M2 is posted, and a read covering M1 only
    // arrives before the system has enqueued M2 - the shade still shows M1 alone.
    @Test
    fun `a read covering only the older line keeps a banner whose newer post the shade has not shown`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, m1)
        shade.drain()
        marks.post(shade, "g1", 1001, m2)
        assertEquals(listOf(m1), shade.read()?.messages)

        assertFalse(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
        shade.drain()
        assertEquals(listOf(m1, m2), shade.read()?.messages)
    }

    // Scenario B: a first banner M1, then a read covering it before the system has enqueued M1.
    @Test
    fun `a read covering a first banner the shade has not shown yet removes it`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, m1)
        assertNull(shade.read())

        assertTrue(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
        shade.drain()
        assertNull(shade.read())
        assertEquals(listOf("notify 1001", "cancel 1001"), shade.events)
    }

    @Test
    fun `a fresh process with nothing posted weighs the shade an earlier one left`() {
        val marks = marks()
        val shade = AsyncShade()
        shade.notify(Banner(1001, "messages", listOf(m1, m2)))
        shade.drain()
        assertFalse(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
        assertTrue(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        shade.drain()
        assertNull(shade.read())
    }

    @Test
    fun `once cancelled the record is dropped, and the shade answers again`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, m1)
        assertTrue(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
        shade.drain()
        assertFalse(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
    }

    @Test
    fun `a banner removed another way, or all of them, is forgotten - the next post starts afresh`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, m1)
        assertTrue(marks.forget("g1"))
        assertFalse(marks.forget("g1"))
        marks.post(shade, "g1", 1001, m2)
        shade.drain()
        assertEquals(listOf(m2), shade.read()?.messages)

        marks.post(shade, "g2", 1002, m1)
        marks.forgetAll {}
        assertNull(marks.bannerOf("g2") { null })
    }

    // Round-3 review (B1): the row lags the shade; the lines hold N, so a read older than N keeps it.
    @Test
    fun `a mark older than the newest line cancels nothing, one covering every line cancels`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, m1)
        marks.post(shade, "g1", 1001, m2)
        assertFalse(marks.readOn(shade, "g1", Read(1_000L, serverClock = true)))
        assertTrue(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
    }

    @Test
    fun `a line comparable on neither clock keeps the banner`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, Msg(sentAt = 500L, serverAt = 0L))
        assertFalse(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        assertTrue(marks.readOn(shade, "g1", Read(600L, serverClock = false)))
    }

    // Round-4 minor 1: an unstamped line is never covered (a banner from the previous build).
    // Round-6 item 5: nor is a PENDING REPLY - the banner is the only place that says "not sent yet".
    @Test
    fun `an unstamped line and a pending reply are never covered`() {
        assertEquals(Line(0L, 0L), Line.of(pendingReply = false, sentAt = null, serverAt = null))
        assertEquals(Line(0L, 0L, pendingReply = true), Line.of(pendingReply = true, sentAt = 5L, serverAt = 6L))
        assertEquals(Line(5L, 0L), Line.of(pendingReply = false, sentAt = 5L, serverAt = null))

        val marks = marks()
        val legacy = Banner(1001, "messages", listOf(Msg(sentAt = null, serverAt = null)))
        assertFalse(marks.recordThenCancel("g1", Read(Long.MAX_VALUE, serverClock = true), shade = { legacy }) {})

        // A read covering every peer line leaves a banner whose pending reply has not gone out.
        val pending = Banner(1002, "messages", listOf(m1, Msg(null, null, pendingReply = true)))
        assertFalse(marks.recordThenCancel("g2", Read(Long.MAX_VALUE, serverClock = true), shade = { pending }) {})
        assertFalse(marks.recordThenCancel("g2", Read(Long.MAX_VALUE, serverClock = false), shade = { pending }) {})
    }

    // Round-6 item 1: a swipe names the notification it removed; another notification of the same
    // conversation (its reaction) must not forget the message banner's record.
    @Test
    fun `a forget naming another notification leaves the record`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, m1)
        assertFalse(marks.forget("g1", notifId = 4242))
        assertEquals(listOf(m1), marks.bannerOf("g1") { null }?.messages)
        assertTrue(marks.forget("g1", notifId = 1001))
        assertNull(marks.bannerOf("g1") { null })
        assertFalse(marks.forget("g1", notifId = 1001))
    }

    @Test
    fun `a post that resolves after the read is covered and touches nothing`() {
        val marks = marks()
        val shade = AsyncShade()
        assertFalse(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        assertFalse(marks.post(shade, "g1", 1001, Msg(1_990L, 2_000L)))
        assertTrue(shade.events.isEmpty())
        assertNull(marks.bannerOf("g1") { null })
    }

    // Round-2 review (B1): the channel switch removed the conversation's CURRENT banner before the
    // check. Every side effect of the post is one step, run only when the post is not covered.
    @Test
    fun `a covered post runs none of its side effects - not even the channel-switch cancel`() {
        val marks = marks()
        marks.record("g1", Read(2_000L, serverClock = true))
        val steps = mutableListOf<String>()
        val posted = marks.postUnlessRead("g1", 1_000L, 1_500L, Banner(1001, "mentions", emptyList())) {
            steps += "cancel previous banner"
            steps += "notify"
        }
        assertFalse(posted)
        assertTrue(steps.isEmpty())
    }

    @Test
    fun `a read that keeps the banner still refuses an older late post`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, Msg(2_900L, 3_000L))
        assertFalse(marks.readOn(shade, "g1", Read(2_000L, serverClock = true)))
        assertFalse(marks.post(shade, "g1", 1001, Msg(1_900L, 1_950L)))
        assertTrue(marks.post(shade, "g1", 1001, Msg(3_500L, 3_600L)))
    }

    /**
     * THE INTERLEAVING: a post that holds the lock (building, then posting) when the read arrives.
     * The read must wait, then weigh the posted line and cancel it. Latches and the reader's own
     * state order it, never a clock.
     */
    @Test
    fun `a read arriving while a post is in flight waits for it, then removes it`() {
        val marks = marks()
        val shade = AsyncShade()
        val inPost = CountDownLatch(1)
        val releasePost = CountDownLatch(1)

        val poster = Thread({
            synchronized(marks.lock) {
                inPost.countDown()
                releasePost.await()
                marks.post(shade, "g1", 1001, Msg(1_000L, 1_000L))
            }
        }, "poster")
        poster.start()
        inPost.await()

        val reader = Thread({ marks.readOn(shade, "g1", Read(1_000L, serverClock = true)) }, "reader")
        reader.start()
        awaitBlocked(reader)
        assertTrue(shade.events.isEmpty())

        releasePost.countDown()
        poster.join()
        reader.join()
        assertEquals(listOf("notify 1001", "cancel 1001"), shade.events)
    }

    @Test
    fun `a post arriving while a read is in flight waits for it, then is refused`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, Msg(500L, 500L))
        shade.events.clear()
        val inRead = CountDownLatch(1)
        val releaseRead = CountDownLatch(1)

        val reader = Thread({
            marks.recordThenCancel("g1", Read(1_000L, serverClock = true), shade = { shade.read() }) {
                inRead.countDown()
                releaseRead.await()
                shade.cancel(it)
            }
        }, "reader")
        reader.start()
        inRead.await()

        var posted = true
        val poster = Thread({ posted = marks.post(shade, "g1", 1001, Msg(1_000L, 1_000L)) }, "poster")
        poster.start()
        awaitBlocked(poster)

        releaseRead.countDown()
        reader.join()
        poster.join()
        assertFalse(posted)
        assertEquals(listOf("cancel 1001"), shade.events)
    }

    @Test
    fun `another conversation is untouched`() {
        val marks = marks()
        marks.record("g1", Read(2_000L, serverClock = true))
        assertFalse(marks.covers("g2", sentAt = 1L, serverAt = 1L))
        assertNull(marks.of("g2"))
    }

    @Test
    fun `the server clock decides when both sides carry it, the stamped one otherwise`() {
        val marks = marks()
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
        val marks = marks()
        marks.record("g1", Read(2_000L, serverClock = true))
        assertFalse(marks.covers("g1", sentAt = 1_000L, serverAt = 0L))
    }

    @Test
    fun `a mark only rises, and an empty id or a non-positive instant records nothing`() {
        val marks = marks()
        marks.record("g1", Read(2_000L, serverClock = true))
        marks.record("g1", Read(1_000L, serverClock = true))
        marks.record("g1", Read(0L, serverClock = false))
        marks.record("", Read(9_000L, serverClock = true))
        assertEquals(ReadElsewhereMarks.Mark(stamped = 0L, server = 2_000L), marks.of("g1"))
        assertNull(marks.of(""))
    }

    /** A cancel with no mark, as `cancelConversationNotification` runs it. */
    private fun ReadElsewhereMarks<Msg>.withdrawOn(shade: AsyncShade, id: String, keepPendingReply: Boolean, stableId: Int? = null): Withdrawal =
        withdraw(id, keepPendingReply, stableId, shade = { shade.read() }, cancel = { shade.cancel(it) })

    // Device reading of #3912 (item 2): the push's silent-from-self cancel removed a banner whose
    // reply was still queued. It cannot weigh peer lines (the mark is in the ciphertext), but it
    // keeps a banner holding a pending reply - from the record or, in a fresh process, the shade.
    @Test
    fun `a cancel with no mark keeps a pending reply when asked, and cancels it otherwise`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, m1)
        marks.remember("g1", Banner(1001, "messages", listOf(m1, Msg(null, null, pendingReply = true))))
        assertEquals(Withdrawal.KEPT_PENDING_REPLY, marks.withdrawOn(shade, "g1", keepPendingReply = true))
        assertTrue(shade.events.none { it.startsWith("cancel") })
        assertEquals(Withdrawal.CANCELLED, marks.withdrawOn(shade, "g1", keepPendingReply = false))
        assertEquals("cancel 1001", shade.events.last())

        val fresh = marks()
        val pendingInShade = Banner(77, "messages", listOf(Msg(null, null, pendingReply = true)))
        assertEquals(Withdrawal.KEPT_PENDING_REPLY, fresh.withdraw("g2", true, 77, shade = { pendingInShade }) { fail("kept") })
        // A banner with no pending reply goes, whatever its lines.
        assertEquals(Withdrawal.CANCELLED, fresh.withdraw("g3", true, 78, shade = { Banner(78, "messages", listOf(m2)) }) {})
    }

    // Device reading of #3912 (item 3): the salon's `channel.read` removed the banner, then its
    // `channel_read` push cancelled it a second time - the shade, which lags a cancel, still showed it.
    @Test
    fun `a banner this process removed is not removed twice, though the shade still shows it`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "ch1", 1002, m1)
        shade.drain()
        assertTrue(marks.readOn(shade, "ch1", Read(1_000L, serverClock = true)))
        // The cancel is queued, not applied: the shade still shows the banner.
        assertEquals(1002, shade.read()?.notifId)
        // Nothing to weigh, nothing to report: the only effect is the silent cancel by id, which
        // the system orders after any `notify` (round-7 review, S1).
        assertEquals(Withdrawal.NONE, marks.withdrawOn(shade, "ch1", keepPendingReply = false, stableId = 1002))
        // ...nor does a post rebuild on the stale copy: it starts a new thread.
        marks.post(shade, "ch1", 1002, m2)
        assertEquals(listOf(m2), marks.bannerOf("ch1") { shade.read() }?.messages)
    }

    @Test
    fun `after every banner was removed at once the shade is never asked again`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.forgetAll {}
        assertNull(marks.bannerOf("g1") { fail("the shade is stale"); null })
        assertEquals(Withdrawal.NONE, marks.withdraw("g1", false, null, shade = { fail("the shade is stale"); null }) {})
        marks.post(shade, "g1", 1001, m1)
        assertEquals(listOf(m1), marks.bannerOf("g1") { null }?.messages)
    }

    // Round-7 review (S1): `forgetAll` after a sweep of a shade that lagged a post left that banner
    // standing, and invisible to every later dismissal. It cancels what it recorded, by id.
    @Test
    fun `forgetAll cancels every recorded banner by id, one the shade has not shown included`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, m1)
        shade.drain()
        marks.post(shade, "g2", 1002, m2) // not drained: the shade has not shown it yet
        val cancelled = mutableListOf<Int>()
        assertEquals(listOf(1001, 1002), marks.forgetAll { shade.cancel(it); cancelled += it }.sorted())
        assertEquals(listOf(1001, 1002), cancelled.sorted())
        shade.drain()
        assertNull(shade.read())
    }

    @Test
    fun `a cancel with no banner known cancels the stable id, unless it must keep a pending reply`() {
        val marks = marks()
        marks.forgetAll {}
        val cancelled = mutableListOf<Int>()
        assertEquals(Withdrawal.NONE, marks.withdraw("g1", false, 1001, shade = { null }) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
        assertEquals(Withdrawal.NONE, marks.withdraw("g1", true, 1001, shade = { null }) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
        assertEquals(Withdrawal.NONE, marks.withdraw("g1", false, null, shade = { null }) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
    }

    // Round-7 review (B1): a reply delivered LATER (the retry worker, a push-woken drain) left the
    // "not sent yet" line for good - and no read elsewhere removes a pending line. Round-8 design: a
    // late delivery is NOT a read - only that line goes, and the read that follows weighs the rest.
    @Test
    fun `a delivered pending reply no longer keeps the banner`() {
        val marks = marks()
        val shade = AsyncShade()
        marks.post(shade, "g1", 1001, m1)
        val pending = Msg(null, null, pendingReply = true, replyId = "r1")
        marks.remember("g1", Banner(1001, "messages", listOf(m1, pending)))
        assertFalse(marks.readOn(shade, "g1", Read(Long.MAX_VALUE, serverClock = true)))

        assertEquals(Delivery.NONE, marks.replyDelivered("g1", "other", 0L, shade = { null }, cancel = { fail("not this reply") }) { _, _ -> throw AssertionError("not this reply") })
        var rebuilt: List<Msg>? = null
        val outcome = marks.replyDelivered("g1", "r1", 0L, shade = { null }, cancel = { fail("the peer line stays") }) { held, kept ->
            rebuilt = kept
            held.copy(messages = kept)
        }
        assertEquals(Delivery.REPOSTED, outcome)
        assertEquals(listOf(m1), rebuilt)
        // Nothing holds the banner any more: the read covering the peer line removes it.
        val cancelled = mutableListOf<Int>()
        assertTrue(marks.recordThenCancel("g1", Read(1_000L, serverClock = true), shade = { null }) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
    }

    @Test
    fun `a late delivery drops only its own line - every peer line and every reply still queued stays`() {
        val marks = marks()
        val r1 = Msg(null, null, pendingReply = true, replyId = "r1")
        val r2 = Msg(null, null, pendingReply = true, replyId = "r2")
        val after = Msg(sentAt = 2_900L, serverAt = 3_000L)
        marks.remember("g1", Banner(1001, "messages", listOf(m1, r1, after, r2)))
        marks.replyDelivered("g1", "r1", 0L, shade = { null }, cancel = { fail("lines stay") }) { held, kept -> held.copy(messages = kept) }
        assertEquals(listOf(m1, after, r2), marks.bannerOf("g1") { null }?.messages)
        // r2 is still queued: a read covering every peer line keeps the banner.
        assertFalse(marks.recordThenCancel("g1", Read(Long.MAX_VALUE, serverClock = true), shade = { null }) { fail("r2 is not sent") })
    }

    @Test
    fun `a banner left with no line goes, and one that cannot be rebuilt is left as it was`() {
        val marks = marks()
        val r1 = Msg(null, null, pendingReply = true, replyId = "r1")
        marks.remember("g1", Banner(1001, "messages", listOf(r1)))
        val cancelled = mutableListOf<Int>()
        assertEquals(Delivery.CANCELLED, marks.replyDelivered("g1", "r1", 0L, shade = { null }, cancel = { cancelled += it }) { _, _ -> throw AssertionError("no line left") })
        assertEquals(listOf(1001), cancelled)
        assertNull(marks.bannerOf("g1") { fail("removed by this process"); null })

        val held = Banner(1002, "messages", listOf(m1, Msg(null, null, pendingReply = true, replyId = "r2")))
        marks.remember("g2", held)
        assertEquals(Delivery.NOT_REBUILT, marks.replyDelivered("g2", "r2", 0L, shade = { null }, cancel = { fail("m1 stays") }) { _, _ -> null })
        assertEquals(held, marks.bannerOf("g2") { null })
    }

    // Round-8/9 review (B1'): a second drain delivers r1 BEFORE the quick reply re-posts it as
    // pending (the reply and the retry worker 5 ms apart). The handler learns it, with the receive
    // time, and runs the first-try success instead of a re-post - it never leaves the spinner.
    @Test
    fun `a delivery that comes before the re-post is handed to the waiting reply`() {
        val marks = marks()
        marks.awaitReply("r1")
        assertNull(marks.replyDeliveredAt("r1"))
        // The other drain delivers r1 while no banner holds it yet.
        assertEquals(Delivery.NONE, marks.replyDelivered("g1", "r1", 4_200L, shade = { null }, cancel = { fail("nothing posted") }) { _, _ -> null })
        assertEquals(4_200L, marks.replyDeliveredAt("r1"))
        marks.settleReply("r1")
        assertNull(marks.replyDeliveredAt("r1"))
    }

    // Round-9 review (S1): no cap to prove - only an awaited reply is recorded, and only while its
    // handler runs.
    @Test
    fun `a delivery nobody awaits records nothing`() {
        val marks = marks()
        repeat(1_000) { i -> marks.replyDelivered("g1", "m$i", 1L, shade = { null }, cancel = {}) { _, _ -> null } }
        assertNull(marks.replyDeliveredAt("m0"))
        assertNull(marks.replyDeliveredAt("m999"))
    }
}
