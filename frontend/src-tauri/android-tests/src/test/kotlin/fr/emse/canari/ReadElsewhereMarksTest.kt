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
    private data class Msg(val sentAt: Long?, val serverAt: Long?, val pendingReply: Boolean = false, val replyId: String? = null, val own: Boolean = false)

    private fun marks() = ReadElsewhereMarks<Msg>(warn = {}) { Line.of(it.pendingReply, it.sentAt, it.serverAt, it.replyId, it.own) }

    /** Nothing is held by the platform: every cancel goes, and nothing is re-posted to release one. */
    private val notHeld: (Int) -> Boolean = { false }
    private val noRepost: (Banner<Msg>, List<Msg>) -> Banner<Msg>? = { _, _ -> throw AssertionError("not held: nothing is re-posted") }
    private val noRepostAll: (String, Banner<Msg>, List<Msg>) -> Banner<Msg>? = { _, _, _ -> throw AssertionError("not held: nothing is re-posted") }

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
        recordThenCancel(id, read, shade = { shade.read() }, holds = notHeld, repost = noRepost, cancel = { shade.cancel(it) })

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
        assertTrue(marks.recordThenCancel("g1", Read(1_000L, serverClock = true), shade = { fail("the record answers"); null }, holds = notHeld, repost = noRepost) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
    }

    @Test
    fun `the cancel gets the shade's id in a fresh process`() {
        val marks = marks()
        val cancelled = mutableListOf<Int>()
        val shown = Banner(77, "messages", listOf(m1))
        assertTrue(marks.recordThenCancel("g1", Read(1_000L, serverClock = true), shade = { shown }, holds = notHeld, repost = noRepost) { cancelled += it })
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
        marks.forgetAll(holds = notHeld, repost = noRepostAll) {}
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
        assertFalse(marks.recordThenCancel("g1", Read(Long.MAX_VALUE, serverClock = true), shade = { legacy }, holds = notHeld, repost = noRepost) {})

        // A read covering every peer line leaves a banner whose pending reply has not gone out.
        val pending = Banner(1002, "messages", listOf(m1, Msg(null, null, pendingReply = true)))
        assertFalse(marks.recordThenCancel("g2", Read(Long.MAX_VALUE, serverClock = true), shade = { pending }, holds = notHeld, repost = noRepost) {})
        assertFalse(marks.recordThenCancel("g2", Read(Long.MAX_VALUE, serverClock = false), shade = { pending }, holds = notHeld, repost = noRepost) {})
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
            marks.recordThenCancel("g1", Read(1_000L, serverClock = true), shade = { shade.read() }, holds = notHeld, repost = noRepost) {
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
        withdraw(id, keepPendingReply, stableId, shade = { shade.read() }, holds = notHeld, repost = noRepost, cancel = { shade.cancel(it) })

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
        assertEquals(Withdrawal.KEPT_PENDING_REPLY, fresh.withdraw("g2", true, 77, shade = { pendingInShade }, holds = notHeld, repost = noRepost) { fail("kept") })
        // A banner with no pending reply goes, whatever its lines.
        assertEquals(Withdrawal.CANCELLED, fresh.withdraw("g3", true, 78, shade = { Banner(78, "messages", listOf(m2)) }, holds = notHeld, repost = noRepost) {})
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
        marks.forgetAll(holds = notHeld, repost = noRepostAll) {}
        assertNull(marks.bannerOf("g1") { fail("the shade is stale"); null })
        assertEquals(Withdrawal.NONE, marks.withdraw("g1", false, null, shade = { fail("the shade is stale"); null }, holds = notHeld, repost = noRepost) {})
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
        assertEquals(listOf(1001, 1002), marks.forgetAll(holds = notHeld, repost = noRepostAll) { shade.cancel(it); cancelled += it }.sorted())
        assertEquals(listOf(1001, 1002), cancelled.sorted())
        shade.drain()
        assertNull(shade.read())
    }

    @Test
    fun `a cancel with no banner known cancels the stable id, unless it must keep a pending reply`() {
        val marks = marks()
        marks.forgetAll(holds = notHeld, repost = noRepostAll) {}
        val cancelled = mutableListOf<Int>()
        assertEquals(Withdrawal.NONE, marks.withdraw("g1", false, 1001, shade = { null }, holds = notHeld, repost = noRepost) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
        assertEquals(Withdrawal.NONE, marks.withdraw("g1", true, 1001, shade = { null }, holds = notHeld, repost = noRepost) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
        assertEquals(Withdrawal.NONE, marks.withdraw("g1", false, null, shade = { null }, holds = notHeld, repost = noRepost) { cancelled += it })
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

        assertEquals(Delivery.NONE, marks.replyDelivered("g1", "other", shade = { null }, cancel = { fail("not this reply") }, holds = notHeld) { _, _ -> throw AssertionError("not this reply") })
        var rebuilt: List<Msg>? = null
        val outcome = marks.replyDelivered("g1", "r1", shade = { null }, cancel = { fail("the peer line stays") }, holds = notHeld) { held, kept ->
            rebuilt = kept
            held.copy(messages = kept)
        }
        assertEquals(Delivery.REPOSTED, outcome)
        assertEquals(listOf(m1), rebuilt)
        // Nothing holds the banner any more: the read covering the peer line removes it.
        val cancelled = mutableListOf<Int>()
        assertTrue(marks.recordThenCancel("g1", Read(1_000L, serverClock = true), shade = { null }, holds = notHeld, repost = noRepost) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
    }

    @Test
    fun `a late delivery drops only its own line - every peer line and every reply still queued stays`() {
        val marks = marks()
        val r1 = Msg(null, null, pendingReply = true, replyId = "r1")
        val r2 = Msg(null, null, pendingReply = true, replyId = "r2")
        val after = Msg(sentAt = 2_900L, serverAt = 3_000L)
        marks.remember("g1", Banner(1001, "messages", listOf(m1, r1, after, r2)))
        marks.replyDelivered("g1", "r1", shade = { null }, cancel = { fail("lines stay") }, holds = notHeld) { held, kept -> held.copy(messages = kept) }
        assertEquals(listOf(m1, after, r2), marks.bannerOf("g1") { null }?.messages)
        // r2 is still queued: a read covering every peer line keeps the banner.
        assertFalse(marks.recordThenCancel("g1", Read(Long.MAX_VALUE, serverClock = true), shade = { null }, holds = notHeld, repost = noRepost) { fail("r2 is not sent") })
    }

    @Test
    fun `a banner left with no line goes, and one that cannot be rebuilt is left as it was`() {
        val marks = marks()
        val r1 = Msg(null, null, pendingReply = true, replyId = "r1")
        marks.remember("g1", Banner(1001, "messages", listOf(r1)))
        val cancelled = mutableListOf<Int>()
        assertEquals(Delivery.CANCELLED, marks.replyDelivered("g1", "r1", shade = { null }, cancel = { cancelled += it }, holds = notHeld) { _, _ -> throw AssertionError("no line left") })
        assertEquals(listOf(1001), cancelled)
        assertNull(marks.bannerOf("g1") { fail("removed by this process"); null })

        val held = Banner(1002, "messages", listOf(m1, Msg(null, null, pendingReply = true, replyId = "r2")))
        marks.remember("g2", held)
        assertEquals(Delivery.NOT_REBUILT, marks.replyDelivered("g2", "r2", shade = { null }, cancel = { fail("m1 stays") }, holds = notHeld) { _, _ -> null })
        assertEquals(held, marks.bannerOf("g2") { null })
    }

    /** The watermark a reply sent from a banner whose newest line is [m2] announces. */
    private val watermarkM2 = listOf(Read(2_000L, serverClock = true), Read(1_900L, serverClock = false))

    /** The answer as the banner draws it: this account's own line. */
    private val answer = Msg(sentAt = 2_500L, serverAt = 2_600L, own = true)

    // Round-10 review (S2, principle 2): answering r2 must not erase ANOTHER reply's line still
    // queued - r0 pending, r2 answered, r0 still failing: r0's line stays, the peer lines go, and
    // the answer is drawn after it (round-12 review, S-b).
    @Test
    fun `an answered reply keeps another reply's pending line and drops the peer lines`() {
        val marks = marks()
        val r0 = Msg(null, null, pendingReply = true, replyId = "r0")
        marks.remember("g1", Banner(1001, "messages", listOf(m1, r0, m2)))
        var rebuilt: List<Msg>? = null
        val outcome = marks.answerReply(
            "g1", "r2", watermarkM2, 1001,
            shade = { null },
            holds = notHeld,
            ownLine = { answer },
            repost = { held, kept ->
                rebuilt = kept
                held.copy(messages = kept)
            },
            cancel = { fail("r0 is not sent") },
        )
        assertEquals(Delivery.REPOSTED, outcome)
        assertEquals(listOf(r0, answer), rebuilt)
        assertEquals(listOf(r0, answer), marks.bannerOf("g1") { null }?.messages)
    }

    // Round-11 review (S2, principle 2): answering is reading UP TO THE WATERMARK. m3 arrived while
    // the reply's drain ran - newer than what the banner showed when the user answered - and stays.
    @Test
    fun `a peer line newer than the answer's watermark stays, the banner rebuilt with it and the answer`() {
        val marks = marks()
        val m3 = Msg(sentAt = 2_900L, serverAt = 3_000L)
        marks.remember("g1", Banner(1001, "messages", listOf(m1, m2)))
        // m3 is posted while the reply is being sent.
        assertTrue(marks.postUnlessRead("g1", 2_900L, 3_000L, Banner(1001, "messages", listOf(m1, m2, m3))) {})
        var rebuilt: List<Msg>? = null
        val outcome = marks.answerReply(
            "g1", "r2", watermarkM2, 1001,
            shade = { null },
            holds = notHeld,
            ownLine = { answer },
            repost = { held, kept ->
                rebuilt = kept
                held.copy(messages = kept)
            },
            cancel = { fail("m3 was never seen") },
        )
        assertEquals(Delivery.REPOSTED, outcome)
        assertEquals(listOf(m3, answer), rebuilt)
        // The watermark is a read this device made: a late post of m2 is refused.
        assertFalse(marks.postUnlessRead("g1", 1_900L, 2_000L, Banner(1001, "messages", listOf(m2))) { fail("m2 was read") })
        // A read covering m3 removes the banner: the answer is covered by any read.
        val cancelled = mutableListOf<Int>()
        assertTrue(marks.recordThenCancel("g1", Read(3_000L, serverClock = true), shade = { null }, holds = notHeld, repost = noRepost) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
    }

    @Test
    fun `an answered reply with no other reply queued cancels the banner, or the stable id when none is known`() {
        val marks = marks()
        val r2 = Msg(null, null, pendingReply = true, replyId = "r2")
        marks.remember("g1", Banner(1001, "messages", listOf(m1, r2)))
        val cancelled = mutableListOf<Int>()
        assertEquals(
            Delivery.CANCELLED,
            marks.answerReply(
                "g1", "r2", watermarkM2, 1001,
                shade = { null },
                holds = notHeld,
                ownLine = { answer },
                repost = { _, _ -> throw AssertionError("nothing stays") },
                cancel = { cancelled += it },
            ),
        )
        assertEquals(listOf(1001), cancelled)
        // Nothing known: the stable id is cancelled, ordered after any `notify`.
        assertEquals(
            Delivery.NONE,
            marks.answerReply(
                "g1", "r3", watermarkM2, 1001,
                shade = { fail("removed by this process"); null },
                holds = notHeld,
                ownLine = { throw AssertionError("no banner") },
                repost = { _, _ -> null },
                cancel = { cancelled += it },
            ),
        )
        assertEquals(listOf(1001, 1001), cancelled)
    }

    // Round-11/12 review (B1, S-b): Android 15+ holds a banner answered inline and drops an app's
    // cancel on it. The silent update - the answer alone, every covered peer line gone - ends the
    // hold; nothing is cancelled in the same breath, and the record holds exactly what is shown.
    @Test
    fun `a banner the platform holds after the answer shows the answer alone, is kept, and the next read removes it`() {
        val marks = marks()
        marks.remember("g1", Banner(1001, "messages", listOf(m1, m2)))
        var shown: List<Msg>? = null
        val outcome = marks.answerReply(
            "g1", "r2", watermarkM2, 1001,
            shade = { null },
            holds = { it == 1001 },
            ownLine = { answer },
            repost = { held, kept ->
                shown = kept
                held.copy(messages = kept)
            },
            cancel = { fail("a cancel now would meet the held record") },
        )
        assertEquals(Delivery.KEPT_UNTIL_READ, outcome)
        assertEquals(listOf(answer), shown)
        assertEquals(listOf(answer), marks.bannerOf("g1") { fail("still recorded: the shade is not asked"); null }?.messages)
        // The next read elsewhere - any mark - removes it, once the platform no longer holds it.
        val cancelled = mutableListOf<Int>()
        assertTrue(marks.recordThenCancel("g1", Read(1L, serverClock = true), shade = { null }, holds = notHeld, repost = noRepost) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
    }

    // Round-12 review (S-a): a read landing while the platform still holds the banner (inside its
    // post delay) does NOT cancel - the cancel would be dropped and the banner forgotten, stuck. It
    // updates again and keeps the record; the next event cancels it.
    @Test
    fun `a read meeting a held banner updates it again and keeps it, and the next event cancels it`() {
        val marks = marks()
        marks.remember("g1", Banner(1001, "messages", listOf(answer)))
        var held = true
        val reposted = mutableListOf<List<Msg>>()
        val repost: (Banner<Msg>, List<Msg>) -> Banner<Msg>? = { b, kept ->
            reposted += kept
            b.copy(messages = kept)
        }
        val cancelled = mutableListOf<Int>()
        assertFalse(marks.recordThenCancel("g1", Read(3_000L, serverClock = true), shade = { null }, holds = { held }, repost = repost) { cancelled += it })
        assertEquals(Withdrawal.HELD, marks.withdraw("g1", false, 1001, shade = { null }, holds = { held }, repost = repost) { cancelled += it })
        assertEquals(emptyList<Int>(), cancelled)
        assertEquals(listOf(listOf(answer), listOf(answer)), reposted)
        assertEquals(listOf(answer), marks.bannerOf("g1") { fail("still recorded"); null }?.messages)
        held = false
        assertEquals(Withdrawal.CANCELLED, marks.withdraw("g1", false, 1001, shade = { null }, holds = { held }, repost = repost) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
    }

    // Round-12 review (S-a): the app coming to the front cancels every recorded banner - but a held
    // one is updated and stays recorded, so a later read still cancels it.
    @Test
    fun `forgetAll updates a held banner and keeps it, and cancels the others`() {
        val marks = marks()
        marks.remember("g1", Banner(1001, "messages", listOf(answer)))
        marks.remember("g2", Banner(1002, "messages", listOf(m1)))
        val reposted = mutableListOf<String>()
        val cancelled = marks.forgetAll(
            holds = { it == 1001 },
            repost = { conversationId, b, kept ->
                reposted += conversationId
                b.copy(messages = kept)
            },
        ) {}
        assertEquals(listOf(1002), cancelled)
        assertEquals(listOf("g1"), reposted)
        assertEquals(null, marks.bannerOf("g2") { fail("the shade is never asked again"); null })
        val gone = mutableListOf<Int>()
        assertTrue(marks.recordThenCancel("g1", Read(1L, serverClock = true), shade = { null }, holds = notHeld, repost = noRepost) { gone += it })
        assertEquals(listOf(1001), gone)
    }

    @Test
    fun `a held banner is also removed by a dismissal that keeps pending replies, having none`() {
        val marks = marks()
        marks.remember("g1", Banner(1001, "messages", listOf(m1, m2)))
        marks.answerReply(
            "g1", "r2", watermarkM2, 1001,
            shade = { null },
            holds = { true },
            ownLine = { answer },
            repost = { b, kept -> b.copy(messages = kept) },
            cancel = { fail("held") },
        )
        val cancelled = mutableListOf<Int>()
        assertEquals(Withdrawal.CANCELLED, marks.withdraw("g1", keepPendingReply = true, stableId = 1001, shade = { null }, holds = notHeld, repost = noRepost) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
    }
    // Round-13 review (S3): a delivery must not leave a banner showing nothing but the user's own
    // answer. [r0 pending, "Vous: r2"], r0 delivered: nothing new is left, so it goes.
    @Test
    fun `a delivery that leaves only the user's own answer cancels the banner`() {
        val marks = marks()
        val r0 = Msg(null, null, pendingReply = true, replyId = "r0")
        marks.remember("g1", Banner(1001, "messages", listOf(r0, answer)))
        val cancelled = mutableListOf<Int>()
        assertEquals(
            Delivery.CANCELLED,
            marks.replyDelivered("g1", "r0", shade = { null }, cancel = { cancelled += it }, holds = notHeld) { _, _ -> throw AssertionError("only the answer is left") },
        )
        assertEquals(listOf(1001), cancelled)
    }

    // Round-13 review (S5): a stable-id cancel for a banner the record does not know is guarded too -
    // a held one is left (and reported), never sent a cancel the platform would drop.
    @Test
    fun `a stable-id cancel is not sent to a banner the platform holds`() {
        val warnings = mutableListOf<String>()
        val marks = ReadElsewhereMarks<Msg>(warn = { warnings += it }) { Line.of(it.pendingReply, it.sentAt, it.serverAt, it.replyId, it.own) }
        val cancelled = mutableListOf<Int>()
        assertEquals(
            Delivery.NONE,
            marks.answerReply(
                "g1", "r2", watermarkM2, 1001,
                shade = { null },
                holds = { it == 1001 },
                ownLine = { throw AssertionError("no banner") },
                repost = { _, _ -> throw AssertionError("no banner") },
                cancel = { cancelled += it },
            ),
        )
        assertEquals(Withdrawal.NONE, marks.withdraw("g1", false, 1001, shade = { null }, holds = { it == 1001 }, repost = noRepost) { cancelled += it })
        assertEquals(emptyList<Int>(), cancelled)
        assertEquals(2, warnings.size)
        // Released: the stable id is cancelled as before.
        assertEquals(Withdrawal.NONE, marks.withdraw("g1", false, 1001, shade = { null }, holds = notHeld, repost = noRepost) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
    }

    // Round-14 review (nit): a held banner with no line is re-posted as it is - any app post ends the
    // hold - and kept, never left held and reported.
    @Test
    fun `a held banner with no line is re-posted as it is and kept`() {
        val warnings = mutableListOf<String>()
        val marks = ReadElsewhereMarks<Msg>(warn = { warnings += it }) { Line.of(it.pendingReply, it.sentAt, it.serverAt, it.replyId, it.own) }
        marks.remember("g1", Banner(1001, "messages", emptyList()))
        val reposted = mutableListOf<List<Msg>>()
        assertEquals(
            Withdrawal.HELD,
            marks.withdraw("g1", false, 1001, shade = { null }, holds = { true }, repost = { b, kept -> reposted += kept; b.copy(messages = kept) }) { fail("held") },
        )
        assertEquals(listOf(emptyList<Msg>()), reposted)
        assertEquals(emptyList<String>(), warnings)
        assertEquals(1001, marks.bannerOf("g1") { null }?.notifId)
    }

    // Round-14 review (S-a): a delivery on a HELD banner re-posts what the delivery LEFT. The
    // sequence: r0 failed offline (its "non envoye" line), the network came back, r2 was answered
    // inline (the platform holds the banner), and the drain delivers r0 then r2. r0's line must
    // never be drawn again - neither on the shade nor in the record.
    @Test
    fun `a delivery on a held banner never re-posts the delivered reply's line`() {
        val marks = marks()
        val r0 = Msg(null, null, pendingReply = true, replyId = "r0")
        marks.remember("g1", Banner(1001, "messages", listOf(m1, r0)))
        val drawn = mutableListOf<List<Msg>>()
        val repost: (Banner<Msg>, List<Msg>) -> Banner<Msg>? = { b, kept -> drawn += kept; b.copy(messages = kept) }
        val held: (Int) -> Boolean = { it == 1001 }
        // r0 delivered: m1 stays unread, the banner is rebuilt without r0.
        assertEquals(Delivery.REPOSTED, marks.replyDelivered("g1", "r0", shade = { null }, cancel = { fail("m1 stays") }, holds = held, repost = repost))
        assertEquals(listOf(m1), marks.bannerOf("g1") { null }?.messages)
        // r2 answered inline: the watermark covers m1, the banner is held, the answer is drawn.
        assertEquals(
            Delivery.KEPT_UNTIL_READ,
            marks.answerReply("g1", "r2", watermarkM2, 1001, shade = { null }, holds = held, ownLine = { answer }, repost = repost, cancel = { fail("held") }),
        )
        assertEquals(listOf(answer), marks.bannerOf("g1") { null }?.messages)
        // A late delivery of r0 again (the drain's second pass) finds no line to remove.
        assertEquals(Delivery.NONE, marks.replyDelivered("g1", "r0", shade = { null }, cancel = { fail("nothing to remove") }, holds = held, repost = repost))
        assertTrue("r0 line was drawn again: $drawn", drawn.none { r0 in it })
        assertTrue(marks.bannerOf("g1") { null }!!.messages.none { it == r0 })
    }

    // The S-a shape on the held path of `replyDelivered` itself: [r0 pending, "Vous: r2"] held,
    // r0 delivered - only the user's own answer is left, the banner is held, and the re-post that
    // ends the hold shows the answer, never r0.
    @Test
    fun `a held banner whose last pending reply is delivered is re-posted without it`() {
        val marks = marks()
        val r0 = Msg(null, null, pendingReply = true, replyId = "r0")
        marks.remember("g1", Banner(1001, "messages", listOf(r0, answer)))
        val drawn = mutableListOf<List<Msg>>()
        assertEquals(
            Delivery.KEPT_UNTIL_READ,
            marks.replyDelivered("g1", "r0", shade = { null }, cancel = { fail("held") }, holds = { true }) { b, kept -> drawn += kept; b.copy(messages = kept) },
        )
        assertEquals(listOf(listOf(answer)), drawn)
        assertEquals(listOf(answer), marks.bannerOf("g1") { null }?.messages)
    }

    // Round-14 decision: a reaction's alert goes WITH the conversation. A reaction line as production
    // stamps it carries no server instant (serverAt 0), so a server-clock mark can never cover it -
    // weighing it on its own kept it forever. What the service weighs is the MESSAGE banner: a read
    // that removes it (true) or finds it held after covering every line removes the reaction too.
    @Test
    fun `a reaction line as production stamps it is never covered, so the read of the message banner decides`() {
        val marks = marks()
        val reaction = Msg(sentAt = 900L, serverAt = 0L)
        marks.remember("g1", Banner(1001, "messages", listOf(m1)))
        val read = Read(2_000L, serverClock = true)
        val cancelled = mutableListOf<Int>()
        assertTrue(marks.recordThenCancel("g1", read, shade = { null }, holds = notHeld, repost = noRepost) { cancelled += it })
        assertEquals(listOf(1001), cancelled)
        assertFalse("a server-clock read covers no reaction line", marks.covers("g1", reaction.sentAt!!, reaction.serverAt!!))
        // Covered but held: `holds` is asked ONLY of a banner every line of which the read covers -
        // the service's signal that the conversation is read, and its reaction goes.
        val asked = mutableListOf<Int>()
        marks.remember("g2", Banner(1002, "messages", listOf(m1)))
        assertFalse(marks.recordThenCancel("g2", read, shade = { null }, holds = { asked += it; true }, repost = { b, kept -> b.copy(messages = kept) }) { fail("held") })
        assertEquals(listOf(1002), asked)
        // Not covered: `holds` is never asked, the reaction stays with an unread banner.
        marks.remember("g3", Banner(1003, "messages", listOf(Msg(sentAt = 2_900L, serverAt = 3_000L))))
        assertFalse(marks.recordThenCancel("g3", read, shade = { null }, holds = { throw AssertionError("not covered: never asked") }, repost = noRepost) { fail("unread") })
    }
}
