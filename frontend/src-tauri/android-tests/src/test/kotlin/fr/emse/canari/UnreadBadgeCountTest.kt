package fr.emse.canari

import fr.emse.canari.push.FixedNotifIds
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Verifies the arithmetic `countUnreadConversations` does, without depending on Android.
 *
 * THE SHADE IS NOT A SOURCE OF TRUTH ABOUT A RECORD YOU JUST MOVED. `NotificationManager.notify`
 * and `cancel` hand the record to `system_server` over a binder queue and return;
 * `activeNotifications` is a SECOND binder call, answered from whatever has already been
 * processed. The real function reads that list and the caller corrects it with the id it moved -
 * which is the whole of what is tested here, the read itself being Android's.
 *
 * WHAT IT COST, AND WHY THE CORRECTION IS NOT AN OPTIMISATION. `refreshBadgeSummary` cancels the
 * group summary when the count is 0, and cancelling a group summary cancels that group's
 * children - the ones still ENQUEUED included. So a count that missed the post made microseconds
 * earlier destroyed the notification it had just built: the app logged a successful
 * `showNotification`, and only the OS said otherwise, with `Cannot find enqueued record for key`.
 * Measured on hardware by `NOTIF-18`, 2026-09-21, where the shade stayed empty for 120 s after a
 * push the phone had decrypted correctly.
 */
class UnreadBadgeCountTest {

    /** The app's reserved ids, which are never conversations - read from the app's own table. */
    private val groupSummaryId = FixedNotifIds.GROUP_SUMMARY
    private val outboxNudgeId = FixedNotifIds.OUTBOX_NUDGE
    private val workerForegroundId = FixedNotifIds.WORKER_FOREGROUND

    /** A record as `activeNotifications` reports it: an id and the channel it was filed under. */
    data class Posted(val id: Int, val channel: String)

    private val messages = "canari_messages_v2"
    private val mentions = "canari_mentions_v2"
    private val reactions = "canari_reactions_v2"

    /**
     * Mirror of `countUnreadConversations`: the set of message conversations in the shade,
     * corrected by what the caller has just posted or cancelled. 0 means "nothing moved" - a
     * conversation id is never 0, the allocator counting from 1000.
     */
    private fun count(shade: List<Posted>, justPosted: Int = 0, justCancelled: Int = 0): Int {
        val ids = shade
            .filter { it.id !in FixedNotifIds.ALL }
            .filter { it.channel == messages || it.channel == mentions }
            .mapTo(mutableSetOf()) { it.id }
        if (justPosted != 0) ids.add(justPosted)
        if (justCancelled != 0) ids.remove(justCancelled)
        return ids.size
    }

    /**
     * THE DEFECT ITSELF: the first message into an empty shade.
     *
     * The post has not been processed, so the shade is still empty - and without the correction the
     * count is 0, the summary is cancelled, and the cancel takes the enqueued child with it.
     */
    @Test
    fun `a post the shade has not caught up with still counts`() {
        val shadeThatHasNotCaughtUp = emptyList<Posted>()

        assertEquals(
            "without the correction this is the 0 that cancels the summary",
            0,
            count(shadeThatHasNotCaughtUp)
        )
        assertEquals(
            "the caller knows it just posted 1002, so the summary must be REBUILT, never cancelled",
            1,
            count(shadeThatHasNotCaughtUp, justPosted = 1002)
        )
    }

    /**
     * AND THE SAME STALE READ THE OTHER WAY, WHICH IS WHAT ARMS THE ABOVE.
     *
     * On a cancel the shade still holds the conversation, so an uncorrected count is one too high
     * and the summary outlives its own last child. That orphan summary is exactly what the
     * post-side branch then cancels, with a freshly enqueued child attached to it.
     */
    @Test
    fun `a cancel the shade still shows does not count`() {
        val shadeThatHasNotCaughtUp = listOf(Posted(1002, messages), Posted(groupSummaryId, messages))

        assertEquals(
            "without the correction the summary survives its last child",
            1,
            count(shadeThatHasNotCaughtUp)
        )
        assertEquals(
            "the caller knows it just cancelled 1002, so the summary goes with it",
            0,
            count(shadeThatHasNotCaughtUp, justCancelled = 1002)
        )
    }

    /** A post already visible must not be counted twice: the correction is a SET, not a `+1`. */
    @Test
    fun `a post the shade has already caught up with is not counted twice`() {
        val shade = listOf(Posted(1002, messages), Posted(1003, mentions))

        assertEquals(2, count(shade))
        assertEquals("1002 is already there", 2, count(shade, justPosted = 1002))
        assertEquals("1004 is not", 3, count(shade, justPosted = 1004))
    }

    /**
     * A REACTION IS NOT A CONVERSATION, and the caller passes 0 for one.
     *
     * It lives on its own channel and is deliberately outside the messages bundle, so counting it
     * would put a badge on something the summary does not describe.
     */
    @Test
    fun `a reaction never joins the count, posted or in the shade`() {
        val shade = listOf(Posted(1002, messages), Posted(7002, reactions))

        assertEquals("the reaction in the shade is not a conversation", 1, count(shade))
        assertEquals(
            "and the caller passes 0 for one rather than its id",
            1,
            count(shade, justPosted = 0)
        )
    }

    /**
     * The reserved ids are not conversations whichever channel they were filed under: the summary,
     * the outbox nudge, and the worker's foreground notice (all on the messages channel).
     */
    @Test
    fun `the summary, the outbox nudge and the worker's notice are never counted`() {
        val shade = listOf(
            Posted(groupSummaryId, messages),
            Posted(outboxNudgeId, messages),
            Posted(workerForegroundId, messages),
        )

        assertEquals(0, count(shade))
        assertTrue(
            "so an empty bundle stays empty and the summary is cancelled, which is correct here",
            count(shade) == 0
        )
    }

    /**
     * Since 1.7.3 the filter is `FixedNotifIds.ALL`, so the new-device notice (9996) and the
     * worker's failure notice (9997), both on the messages channel, are no longer counted as
     * unread conversations - before, they raised the badge by one each.
     */
    @Test
    fun `the new-device and the worker-failure notices are not conversations`() {
        val shade = listOf(
            Posted(FixedNotifIds.NEW_DEVICE, messages),
            Posted(FixedNotifIds.BACKGROUND_FAILURE, messages),
            Posted(1000, messages),
        )
        assertEquals(9996, FixedNotifIds.NEW_DEVICE)
        assertEquals(9997, FixedNotifIds.BACKGROUND_FAILURE)
        assertEquals(1, count(shade))
    }

    /** Both corrections in one call: one conversation read while another arrives. */
    @Test
    fun `a post and a cancel in flight at once resolve independently`() {
        val shade = listOf(Posted(1002, messages))

        assertEquals(
            "1002 read, 1003 arriving - one conversation is unread, not zero and not two",
            1,
            count(shade, justPosted = 1003, justCancelled = 1002)
        )
    }
}
