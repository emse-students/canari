package fr.emse.canari.push

/**
 * HOW FAR THIS ACCOUNT HAS READ EACH CONVERSATION ON ANOTHER DEVICE, as the WebView learned it
 * over its socket, AND WHAT THIS PROCESS HAS POSTED FOR EACH (2026-11-20) - the two facts a post and
 * a read are weighed against, so that the order in which a message's banner and the read covering
 * it reach the native side decides nothing.
 *
 * WHY A RECORD AND NOT JUST A CANCEL. The WebView's post of a message is asynchronous before it
 * reaches Kotlin (the sender's name is resolved and the name files flushed first), while the read
 * covering it may be handed over at once. A cancel that lands first finds nothing to remove, and the
 * post that follows would put up a banner for a message already read - for good. So a read RECORDS
 * its mark - always - and every post asks it: a message at or below the mark is not posted.
 *
 * THE LINES DECIDE THE CANCEL, NOT THE WEBVIEW'S ROW. A read removes the conversation's banner only
 * when its mark covers EVERY line that banner holds, compared on the same clock rule as a post
 * ([covers]). The WebView's row can lag behind the shade - a frozen WebView drains an own read from
 * before a message the push already announced, and its row, which has not received that message
 * yet, counts nothing unread (round-3 review of #3912).
 *
 * THE BANNER IS WHAT THIS PROCESS POSTED, NOT THE SHADE'S ANSWER. `notify` returns before the system
 * has enqueued the record, so the shade read right after a post can still show the notification
 * from BEFORE it. Weighing it, a read would cancel a banner without seeing its newest line (that line
 * lost) or find nothing to cancel (a read banner left standing); re-injecting from it, a second post
 * would drop the first one's line. So every post records the [Banner] it handed to `notify` - its id,
 * its channel, its messages - and both the next post and a read start from that record; the shade
 * ([bannerOf]'s fallback) answers only when this process has neither posted nor removed anything
 * for the conversation (a fresh process, whose banner an earlier one left): the shade lags a
 * `cancel` exactly as it lags a `notify`, so once this process has removed a banner, the shade's
 * copy of it is stale and nothing may rebuild on it, weigh it or cancel it a second time. The record
 * goes with the banner: removed by a read ([recordThenCancel]), any other cancel ([withdraw]) or the
 * user's own dismissal ([forget], [forgetAll]) - each under this lock with the cancel it follows, so
 * no post falls between the two.
 *
 * ONE LOCK, [lock], held by a post from the moment it reads the banner it re-injects to the moment
 * it records what it posted ([showMessageNotification] takes it around that whole section), and by a
 * read across record, weigh and cancel. Whichever takes it first, the other sees its effect. It is
 * reentrant (the methods below take it too).
 *
 * WHAT RUNS UNDER IT, so its ordering stays checkable. Inside a post's section the builder takes
 * three LEAF locks, none of which ever takes this one: `ALERTED_LOCK` (the announced-message set,
 * read only - the write that commits it runs after the lock is released), the ring sequencer's
 * lock (`callHoldsSound` counts the native rings), and the monitor of `ConversationShortcuts.push`
 * (which commits its shortcut record - a durability the sign-out relies on - and pushes the
 * shortcut). Its blocking work is binder calls (the shade read, `notify`, `cancel`, the shortcut
 * push), that shortcut record's commit, and building the notification from bitmaps loaded BEFORE
 * the lock - no fetch or decode of a picture runs under it. The WebSocket post enters it holding
 * the generic-banner lock; nothing under it takes that lock, and no path takes them the other way
 * round. A read or a cancel does only the shade read and the `cancel` under it; a delivered reply
 * ([replyDelivered]) the shade read and a `cancel` or one rebuilt `notify`, entered from the drain
 * AFTER it released the outbox lock, so no lock order is shared with the outbox.
 *
 * IN MEMORY, ON PURPOSE. The races it closes are between a post still being built, a read this
 * process was told about, and the system's own queue; all of them die with the process.
 *
 * TWO CLOCKS, as everywhere a mark lives (readState.ts): the server's `createdAt` when the mark is
 * on it (a DM or group mark from this build), the stamped one otherwise (a salon, whose stamp IS its
 * server time, or an older sender's bare `at`). Each only rises.
 *
 * Generic over the message type [M] so the JVM suite drives it with its own fake messages; [lineOf]
 * says what each message counts as. Compiled by the JVM test project too, so nothing here may import
 * Android - see [PushRecoveryLadder] for why that is the guard.
 */
class ReadElsewhereMarks<M>(private val lineOf: (M) -> Line) {

    /** One conversation's mark on each clock; 0 = not known on that clock. */
    data class Mark(val stamped: Long, val server: Long)

    /** A read as the WebView hands it over: the instant, and whether it is on the server's clock. */
    data class Read(val at: Long, val serverClock: Boolean)

    /**
     * One line of a conversation's notification, as this side stamped it when it posted it: the
     * sender's instant and the server's (0 when unknown, and both 0 for a line that carries no
     * stamp - never covered), and whether it is this account's PENDING REPLY - which no read covers
     * and no cancel that cannot weigh lines removes ([withdraw]) - with the id of the message it
     * stands for, so its delivery, whenever and by whichever path, clears it ([replyDelivered]).
     */
    data class Line(
        val sentAt: Long,
        val serverAt: Long,
        val pendingReply: Boolean = false,
        val pendingReplyId: String? = null,
    ) {
        companion object {
            /**
             * The line a message of the notification counts as: its stamps when it carries them, and
             * an UNCOVERABLE line otherwise - for a PENDING REPLY (this account's own send that has
             * not gone out: no read on another device says anything about it, and the banner is the
             * only place that says "not sent yet"), and for a banner from a build that did not stamp
             * its lines (not proven read by any mark, so it is kept).
             */
            fun of(pendingReply: Boolean, sentAt: Long?, serverAt: Long?, pendingReplyId: String? = null): Line = when {
                pendingReply -> Line(0L, 0L, pendingReply = true, pendingReplyId = pendingReplyId)
                sentAt == null -> Line(0L, 0L)
                else -> Line(sentAt, serverAt ?: 0L)
            }
        }
    }

    /**
     * A conversation notification as posted: its id, its channel (null below API 26), its messages,
     * and the notification itself ([posted], opaque here - Android's type), the template a rebuild
     * of the banner starts from without asking the shade.
     */
    data class Banner<M>(val notifId: Int, val channelId: String?, val messages: List<M>, val posted: Any? = null)

    /** What a [withdraw] did. */
    enum class Withdrawal {
        /** No banner: never posted, or already removed by this process - nothing to do, nothing to say. */
        NONE,

        /** The banner holds a pending reply, and the caller asked to keep one. */
        KEPT_PENDING_REPLY,

        /** The banner was cancelled. */
        CANCELLED,
    }

    /** What a [replyDelivered] did. */
    enum class Delivery {
        /** No banner holds that pending reply: nothing to clear. */
        NONE,

        /** It was the banner's only line left: the banner went. */
        CANCELLED,

        /** Other lines stay: the banner was rebuilt without it. */
        REPOSTED,

        /** Other lines stay, but the banner could not be rebuilt: it is left as it was. */
        NOT_REBUILT,
    }

    /** The one lock - see the class comment. */
    val lock = Any()

    /** Guarded by [lock]. */
    private val marks = HashMap<String, Mark>()

    /** The banner this process last handed to `notify`, per conversation. Guarded by [lock]. */
    private val posted = HashMap<String, Banner<M>>()

    /**
     * The conversations whose banner THIS process removed and has not posted since: the shade's copy
     * of them is stale (it lags a `cancel`), so [bannerOf] does not ask it. Guarded by [lock].
     */
    private val withdrawn = HashSet<String>()

    /**
     * Every banner was removed at once ([forgetAll]): from then on the shade holds nothing this
     * process did not post and record, so it is never asked again. Guarded by [lock].
     */
    private var allWithdrawn = false

    /**
     * The quick replies whose handler is still running ([awaitReply] .. [settleReply]), each with the
     * server's receive time once a drain DELIVERED it ([replyDelivered]), null until then. The
     * handler decides from it - under [lock] - whether another drain sent its reply while it was
     * replying ([replyDeliveredAt]).
     *
     * BOUNDED BY CONSTRUCTION, NOT BY A CAP: an id is added before its entry can reach the outbox
     * (so no drain can deliver it unseen) and removed when its handler ends, so the map holds at
     * most one entry per quick reply in flight - and a delivery of any other message records
     * nothing here. No eviction, so no number to prove against the drain's batch. Guarded by [lock].
     */
    private val awaited = HashMap<String, Long?>()

    /**
     * Raises [conversationId]'s mark to [read]'s instant, on its clock. A lower or non-positive
     * instant changes nothing.
     */
    fun record(conversationId: String, read: Read) {
        synchronized(lock) { recordLocked(conversationId, read) }
    }

    /**
     * The conversation's banner as a post should build on it and a read should weigh it: what this
     * process last posted, else - when this process has not removed it - what [shade] answers (null
     * when nothing is posted there either).
     */
    fun bannerOf(conversationId: String, shade: () -> Banner<M>?): Banner<M>? =
        synchronized(lock) { bannerOfLocked(conversationId, shade) }

    /**
     * Cancels the conversation's banner ([bannerOf]) for a dismissal that cannot weigh its lines (no
     * mark: a push whose mark is in the ciphertext, a "mark as read" action, a delivered reply), all
     * in ONE critical section, so no post falls between the cancel and the record's removal. A banner
     * holding a pending reply stays when [keepPendingReply] - a read on another device says nothing
     * about a send that has not gone out. A banner this process already removed is not weighed
     * again: the shade's lagging copy of it is not asked.
     *
     * With no banner known ([Withdrawal.NONE]) and nothing to keep, [stableId] is still cancelled -
     * a cancel by id is ordered after its `notify` by the system, so a banner the record lost sight
     * of (posted just before a [forgetAll]) cannot outlive a dismissal. A dismissal that must keep a
     * pending reply cannot cancel what it cannot see.
     */
    fun withdraw(
        conversationId: String,
        keepPendingReply: Boolean,
        stableId: Int?,
        shade: () -> Banner<M>?,
        cancel: (notifId: Int) -> Unit,
    ): Withdrawal = synchronized(lock) {
        val banner = bannerOfLocked(conversationId, shade)
        if (banner == null) {
            if (!keepPendingReply && stableId != null) cancel(stableId)
            return@synchronized Withdrawal.NONE
        }
        if (keepPendingReply && banner.messages.any { lineOf(it).pendingReply }) {
            return@synchronized Withdrawal.KEPT_PENDING_REPLY
        }
        cancel(banner.notifId)
        withdrawnLocked(conversationId)
        Withdrawal.CANCELLED
    }

    /**
     * Records [read], then weighs the conversation's banner ([bannerOf]) and runs [cancel] with
     * ITS id only when the mark covers EVERY line - all in ONE critical section, so no post can fall
     * between them. A line the mark does not cover - a message newer than the read, or one comparable
     * on neither clock, or a pending reply - keeps the banner: it is a message this account has not
     * read, or a send that has not gone out.
     *
     * @return whether [cancel] ran.
     */
    fun recordThenCancel(
        conversationId: String,
        read: Read,
        shade: () -> Banner<M>?,
        cancel: (notifId: Int) -> Unit,
    ): Boolean = synchronized(lock) {
        recordLocked(conversationId, read)
        val banner = bannerOfLocked(conversationId, shade) ?: return@synchronized false
        val lines = banner.messages.map(lineOf)
        if (lines.all { coversLocked(conversationId, it.sentAt, it.serverAt) }) {
            cancel(banner.notifId)
            withdrawnLocked(conversationId)
            true
        } else {
            false
        }
    }

    /**
     * The pending reply [messageId] was DELIVERED - by whichever path, whenever ([replyDelivered] is
     * called by the one drain every native send goes through). A LATE DELIVERY IS NOT A READ: only
     * the line carrying that id goes. Every peer line stays, to be weighed by a later read as usual,
     * and so does every other pending reply still queued - nothing unseen is ever dropped (principle
     * 2). The banner is cancelled when no line is left, else [repost] rebuilds it with the lines that
     * stay and returns what it posted (null: it could not, and the banner is left as it was). A
     * quick reply whose handler still runs learns of it, with [receivedAt] ([replyDeliveredAt]).
     * All in one critical section with the record.
     */
    fun replyDelivered(
        conversationId: String,
        messageId: String,
        receivedAt: Long,
        shade: () -> Banner<M>?,
        cancel: (notifId: Int) -> Unit,
        repost: (held: Banner<M>, kept: List<M>) -> Banner<M>?,
    ): Delivery = synchronized(lock) {
        if (awaited.containsKey(messageId)) awaited[messageId] = receivedAt
        val banner = bannerOfLocked(conversationId, shade) ?: return@synchronized Delivery.NONE
        val at = banner.messages.indexOfFirst { lineOf(it).pendingReplyId == messageId }
        if (at < 0) return@synchronized Delivery.NONE
        val kept = banner.messages.filterIndexed { i, _ -> i != at }
        if (kept.isEmpty()) {
            cancel(banner.notifId)
            withdrawnLocked(conversationId)
            return@synchronized Delivery.CANCELLED
        }
        val rebuilt = repost(banner, kept) ?: return@synchronized Delivery.NOT_REBUILT
        postedLocked(conversationId, rebuilt)
        Delivery.REPOSTED
    }

    /**
     * A quick reply's handler starts: from now until [settleReply], a drain that delivers
     * [messageId] says so here. Called BEFORE the entry is queued, so no delivery can be missed.
     */
    fun awaitReply(messageId: String) {
        synchronized(lock) { awaited[messageId] = null }
    }

    /**
     * The server's receive time of reply [messageId] when a drain delivered it while its handler
     * runs, else null. Asked by the handler after its own drain, and again under [lock] by its
     * re-post as pending: a second drain may have delivered it in between (a quick reply and the
     * retry worker 5 ms apart, Mi 9T).
     */
    fun replyDeliveredAt(messageId: String): Long? = synchronized(lock) { awaited[messageId] }

    /** The quick reply's handler ends: [messageId] is no longer awaited. */
    fun settleReply(messageId: String) {
        synchronized(lock) { awaited.remove(messageId) }
    }

    /**
     * Runs [post] - EVERY side effect a post has on the shade, the removal of the previous banner
     * included - only when the message is not covered by a read, in one critical section with the
     * check, and records [banner] as what is now posted. A covered message touches nothing:
     * removing the conversation's current banner for a message that is then not posted would take a
     * newer message's banner down with it.
     *
     * @return whether [post] ran.
     */
    fun postUnlessRead(
        conversationId: String,
        sentAt: Long,
        serverAt: Long,
        banner: Banner<M>,
        post: () -> Unit,
    ): Boolean = synchronized(lock) {
        if (coversLocked(conversationId, sentAt, serverAt)) {
            false
        } else {
            post()
            postedLocked(conversationId, banner)
            true
        }
    }

    /** Records [banner] as posted for [conversationId], for a post that is not a message (an own line). */
    fun remember(conversationId: String, banner: Banner<M>) {
        synchronized(lock) { postedLocked(conversationId, banner) }
    }

    /**
     * Drops what this process posted for [conversationId]: its banner was removed another way. With
     * [notifId], only when the record is THAT notification's - a swipe of another notification of the
     * same conversation (its reaction) leaves the message banner's record alone.
     *
     * @return whether a record was dropped.
     */
    fun forget(conversationId: String, notifId: Int? = null): Boolean = synchronized(lock) {
        val held = posted[conversationId] ?: return@synchronized false
        if (notifId != null && held.notifId != notifId) return@synchronized false
        withdrawnLocked(conversationId)
        true
    }

    /**
     * Drops every record: every message banner is removed at once (the app came to the front). Each
     * RECORDED banner is [cancel]led by its id here, under the lock: the caller's sweep of the shade
     * misses a banner posted just before it (the shade lags a `notify`), and once this returns the
     * shade is never asked again - so that banner would stand for good. The system orders a cancel
     * by id after its `notify`.
     *
     * @return the ids cancelled.
     */
    fun forgetAll(cancel: (notifId: Int) -> Unit): List<Int> = synchronized(lock) {
        val ids = posted.values.map { it.notifId }
        ids.forEach(cancel)
        posted.clear()
        withdrawn.clear()
        allWithdrawn = true
        ids
    }

    /** The mark held for [conversationId], or null. */
    fun of(conversationId: String): Mark? = synchronized(lock) { marks[conversationId] }

    /**
     * Whether a message stamped [sentAt] by its sender and accepted by the server at [serverAt]
     * (0 when unknown) has already been read elsewhere.
     *
     * On the server clock when both the message and the mark carry it; else on the stamped clock
     * when both carry that. A message that can be compared on neither is NOT covered: a banner for a
     * read message is noise, a lost banner for an unread one is a lost message.
     */
    fun covers(conversationId: String, sentAt: Long, serverAt: Long): Boolean =
        synchronized(lock) { coversLocked(conversationId, sentAt, serverAt) }

    private fun bannerOfLocked(conversationId: String, shade: () -> Banner<M>?): Banner<M>? =
        posted[conversationId] ?: if (allWithdrawn || conversationId in withdrawn) null else shade()

    private fun postedLocked(conversationId: String, banner: Banner<M>) {
        posted[conversationId] = banner
        withdrawn.remove(conversationId)
    }

    private fun withdrawnLocked(conversationId: String) {
        posted.remove(conversationId)
        withdrawn.add(conversationId)
    }

    private fun recordLocked(conversationId: String, read: Read) {
        if (conversationId.isEmpty() || read.at <= 0L) return
        val held = marks[conversationId] ?: Mark(0L, 0L)
        marks[conversationId] = if (read.serverClock) {
            held.copy(server = maxOf(held.server, read.at))
        } else {
            held.copy(stamped = maxOf(held.stamped, read.at))
        }
    }

    private fun coversLocked(conversationId: String, sentAt: Long, serverAt: Long): Boolean {
        val mark = marks[conversationId] ?: return false
        return when {
            serverAt > 0L && mark.server > 0L -> serverAt <= mark.server
            sentAt > 0L && mark.stamped > 0L -> sentAt <= mark.stamped
            else -> false
        }
    }
}
