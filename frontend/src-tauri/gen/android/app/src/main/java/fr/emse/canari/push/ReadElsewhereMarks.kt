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
 * user's own dismissal ([forget], [clear]) - each under this lock with the cancel it follows, so
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
 * AFTER it released the outbox lock, so no lock order is shared with the outbox. The pending reply's
 * re-post asks [AwaitedReplies] under it - a leaf lock, which the drain also takes under the outbox
 * lock and under which nothing is taken.
 *
 * A BANNER THE PLATFORM HOLDS IS NEVER CANCELLED BY THIS PROCESS (round-12 review of #3912). Android
 * 15+ keeps a banner answered inline (`FLAG_LIFETIME_EXTENDED_BY_DIRECT_REPLY`), DROPS an app's
 * cancel on it and re-extends the record; only an app's post ends the hold, and that post lands on
 * the system's queue later than a cancel sent behind it would. So every cancel of a recorded banner
 * asks the shade first (`holds`, a fact read from the shade's copy, never a guess about latency): a
 * held banner is posted again, silently, with what it shows (`repost`), and STAYS recorded - the
 * next event (a read, a dismissal, a post, the app's start) weighs it again. Each such event either
 * finds it no longer held and cancels it, or updates it again; none forgets it.
 *
 * IN MEMORY, ON PURPOSE. The races it closes are between a post still being built, a read this
 * process was told about, and the system's own queue; all of them die with the process.
 *
 * TWO CLOCKS, as everywhere a mark lives (readState.ts): the server's `createdAt` when the mark is
 * on it (a DM or group mark from this build), the stamped one otherwise (a salon, whose stamp IS its
 * server time, or an older sender's bare `at`). Each only rises.
 *
 * Generic over the message type [M] so the JVM suite drives it with its own fake messages; [lineOf]
 * says what each message counts as, and [warn] is where a state worth accusing is reported (the
 * service's `Log.w`). Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
class ReadElsewhereMarks<M>(
    private val warn: (String) -> Unit,
    private val lineOf: (M) -> Line,
) {

    /** One conversation's mark on each clock; 0 = not known on that clock. */
    data class Mark(val stamped: Long, val server: Long)

    /** A read as the WebView hands it over: the instant, and whether it is on the server's clock. */
    data class Read(val at: Long, val serverClock: Boolean)

    /**
     * One line of a conversation's notification, as this side stamped it when it posted it: the
     * sender's instant and the server's (0 when unknown, and both 0 for a line that carries no
     * stamp - never covered), and whether it is this account's PENDING REPLY - which no read covers
     * and no cancel that cannot weigh lines removes ([withdraw]) - with the id of the message it
     * stands for, so its delivery, whenever and by whichever path, clears it ([replyDelivered]). An
     * [own] line is this account's ANSWER, shown on the banner after a quick reply ([answerReply]):
     * nothing in it is unread, so every read covers it.
     */
    data class Line(
        val sentAt: Long,
        val serverAt: Long,
        val pendingReply: Boolean = false,
        val pendingReplyId: String? = null,
        val own: Boolean = false,
    ) {
        companion object {
            /**
             * The line a message of the notification counts as: its stamps when it carries them, and
             * an UNCOVERABLE line otherwise - for a PENDING REPLY (this account's own send that has
             * not gone out: no read on another device says anything about it, and the banner is the
             * only place that says "not sent yet"), and for a banner from a build that did not stamp
             * its lines (not proven read by any mark, so it is kept).
             */
            fun of(pendingReply: Boolean, sentAt: Long?, serverAt: Long?, pendingReplyId: String? = null, own: Boolean = false): Line = when {
                pendingReply -> Line(0L, 0L, pendingReply = true, pendingReplyId = pendingReplyId)
                own -> Line(sentAt ?: 0L, serverAt ?: 0L, own = true)
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

        /** The platform holds the banner (answered inline): updated silently, kept for the next event. */
        HELD,
    }

    /** What a read ([recordThenCancel]) did - each outcome decides the conversation's reaction notification. */
    enum class ReadOutcome {
        /** No banner: never posted, or already removed by this process. The conversation is read. */
        NO_BANNER,

        /** The read covered every line: the banner was cancelled. */
        CANCELLED,

        /** The read covered every line, but the platform holds the banner: re-posted empty and kept. */
        HELD,

        /**
         * The read covered every MESSAGE line; only a pending reply ([Line.pendingReply]) - a send of
         * this account's that has not gone out - keeps the banner. The conversation is read.
         */
        PENDING_ONLY,

        /** A message line the read does not cover stays unread: the banner stands as it was. */
        UNREAD,
    }

    /** What a [replyDelivered] or an [answerReply] did. */
    enum class Delivery {
        /** No banner holds that pending reply: nothing to clear. */
        NONE,

        /** It was the banner's only line left: the banner went. */
        CANCELLED,

        /** Other lines stay: the banner was rebuilt without it. */
        REPOSTED,

        /** Other lines stay, but the banner could not be rebuilt: it is left as it was. */
        NOT_REBUILT,

        /**
         * The platform holds the banner (Android 15+, answered inline - a cancel would be dropped):
         * it was updated silently instead, which ends that hold, and stays recorded with what it
         * shows - the next read, dismissal or post weighs it again.
         */
        KEPT_UNTIL_READ,
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
     * Every banner was removed at once ([clear], at a sign-out): from then on the shade holds nothing this
     * process did not post and record, so it is never asked again. Guarded by [lock].
     */
    private var allWithdrawn = false

    /**
     * The conversations whose REACTION notification this process removed and has not posted since:
     * the shade lags a `cancel`, so a reaction posted right after would rebuild on the removed lines
     * ([reactionBaseOf]). Guarded by [lock].
     */
    private val reactionsWithdrawn = HashSet<String>()

    /**
     * Every reaction notification was swept at once ([clear], at a sign-out), and only the conversations in [reactionsPostedSinceSweep] posted one
     * since. Guarded by [lock].
     */
    private var reactionsSwept = false

    /**
     * The REACTION notification id each conversation posted since the last sweep (or since this
     * process started): [clear] cancels them BY ID, as it does the message banners - the
     * caller's sweep reads a shade that lags a `notify`. Guarded by [lock].
     */
    private val reactionsPostedSinceSweep = HashMap<String, Int>()

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
     * of (posted just before a [clear]) cannot outlive a dismissal. A dismissal that must keep a
     * pending reply cannot cancel what it cannot see. A banner the platform [holds] is re-posted
     * EMPTY through [repost] - every line it showed is dismissed - and kept ([Withdrawal.HELD], see
     * the class comment).
     */
    fun withdraw(
        conversationId: String,
        keepPendingReply: Boolean,
        stableId: Int?,
        shade: () -> Banner<M>?,
        holds: (notifId: Int) -> Boolean,
        repost: (held: Banner<M>, kept: List<M>) -> Banner<M>?,
        cancel: (notifId: Int) -> Unit,
    ): Withdrawal = synchronized(lock) {
        val banner = bannerOfLocked(conversationId, shade)
        if (banner == null) {
            if (!keepPendingReply && stableId != null) cancelUnlessHeldUnknownLocked(stableId, holds, cancel)
            return@synchronized Withdrawal.NONE
        }
        if (keepPendingReply && banner.messages.any { lineOf(it).pendingReply }) {
            return@synchronized Withdrawal.KEPT_PENDING_REPLY
        }
        // Dismissed: a held banner is re-posted EMPTY - every line it showed is dismissed.
        if (cancelUnlessHeldLocked(conversationId, banner, emptyList(), holds, repost, cancel)) Withdrawal.CANCELLED else Withdrawal.HELD
    }

    /**
     * Records [read], then weighs the conversation's banner ([bannerOf]) and runs [cancel] with
     * ITS id only when the mark covers EVERY line - all in ONE critical section, so no post can fall
     * between them. A line the mark does not cover - a message newer than the read, or one comparable
     * on neither clock, or a pending reply - keeps the banner: it is a message this account has not
     * read ([ReadOutcome.UNREAD]), or a send that has not gone out ([ReadOutcome.PENDING_ONLY]: the
     * conversation itself is read). An own line ([Line.own]) is covered by any read. A covered
     * banner the platform [holds] is re-posted EMPTY through [repost] - every line it showed is read
     * - and kept (class comment).
     */
    fun recordThenCancel(
        conversationId: String,
        read: Read,
        shade: () -> Banner<M>?,
        holds: (notifId: Int) -> Boolean,
        repost: (held: Banner<M>, kept: List<M>) -> Banner<M>?,
        cancel: (notifId: Int) -> Unit,
    ): ReadOutcome = synchronized(lock) {
        recordLocked(conversationId, read)
        val banner = bannerOfLocked(conversationId, shade) ?: return@synchronized ReadOutcome.NO_BANNER
        val uncovered = banner.messages.map(lineOf).filterNot { it.own || coversLocked(conversationId, it.sentAt, it.serverAt) }
        when {
            uncovered.any { !it.pendingReply } -> ReadOutcome.UNREAD
            uncovered.isNotEmpty() -> ReadOutcome.PENDING_ONLY
            cancelUnlessHeldLocked(conversationId, banner, emptyList(), holds, repost, cancel) -> ReadOutcome.CANCELLED
            else -> ReadOutcome.HELD
        }
    }

    /**
     * The REACTION notification a reaction post of [conversationId] builds on: what [shade] answers,
     * or nothing when this process removed it and has not posted one since - the shade's copy is
     * stale then (it lags a `cancel`), and a post on it would bring the removed reactions back.
     */
    fun reactionBaseOf(conversationId: String, shade: () -> Banner<M>?): Banner<M>? =
        synchronized(lock) {
            val stale = conversationId in reactionsWithdrawn || (reactionsSwept && conversationId !in reactionsPostedSinceSweep.keys)
            if (stale) null else shade()
        }

    /** [conversationId]'s reaction notification was removed: [reactionBaseOf] no longer asks the shade. */
    fun reactionWithdrawn(conversationId: String) {
        synchronized(lock) { reactionsWithdrawn += conversationId }
    }

    /**
     * A reaction of [conversationId] was posted as [notifId]: the shade answers again from now on, and
     * the next [clear] cancels it by id.
     */
    fun reactionPosted(conversationId: String, notifId: Int) {
        synchronized(lock) {
            reactionsWithdrawn -= conversationId
            reactionsPostedSinceSweep[conversationId] = notifId
        }
    }

    /**
     * The pending reply [messageId] was DELIVERED - by whichever path of a live process, whenever
     * ([replyDelivered] is called by the one drain every native send goes through, after it released
     * the outbox lock). A LATE DELIVERY IS NOT A READ: only
     * the line carrying that id goes. Every peer line stays, to be weighed by a later read as usual,
     * and so does every other pending reply still queued - nothing unseen is ever dropped (principle
     * 2). The banner is cancelled when nothing UNREAD is left (an own answer alone counts as empty),
     * else [repost] rebuilds it with the lines that stay and returns what it posted (null: it could not, and the banner is left as it was). All in
     * one critical section with the record. (A quick reply whose handler still runs learned of the
     * delivery earlier, at the send, through [AwaitedReplies].) A peer line the conversation's mark
     * ALREADY covers - a read that came while the reply was queued - goes with it: it was read, and a
     * re-post must not show it again - unless an answer ("Vous") stays, which keeps the history it
     * was answered under, as [answerReply] drew it. With nothing unread left, a banner the
     * platform [holds] - answered inline again since the pending re-post - is updated WITHOUT the
     * delivered line and kept ([Delivery.KEPT_UNTIL_READ]): that later answer's own [answerReply]
     * sets what it shows.
     */
    fun replyDelivered(
        conversationId: String,
        messageId: String,
        shade: () -> Banner<M>?,
        cancel: (notifId: Int) -> Unit,
        holds: (notifId: Int) -> Boolean,
        repost: (held: Banner<M>, kept: List<M>) -> Banner<M>?,
    ): Delivery = synchronized(lock) {
        val banner = bannerOfLocked(conversationId, shade) ?: return@synchronized Delivery.NONE
        val at = banner.messages.indexOfFirst { lineOf(it).pendingReplyId == messageId }
        if (at < 0) return@synchronized Delivery.NONE
        // A peer line a read ALREADY covers is not shown again (round-16 review): [m1, r0], a read
        // covering m1, then r0 delivered - m1 was read, and the banner has nothing left to say.
        // EXCEPT ABOVE AN ANSWER (2026-11-26): a banner showing "Vous" keeps the history it was
        // answered under ([answerReply]) - [m1, r0, "Vous: r2"], r0 delivered, must not fall back to
        // "Vous" over nothing. The covered lines never keep it up: only an unread one does.
        val rest = banner.messages.filterIndexed { i, _ -> i != at }
        val answered = rest.any { lineOf(it).own }
        val kept = rest.filter {
            val line = lineOf(it)
            answered || line.own || line.pendingReply || !coversLocked(conversationId, line.sentAt, line.serverAt)
        }
        val unread = kept.any {
            val line = lineOf(it)
            !line.own && (line.pendingReply || !coversLocked(conversationId, line.sentAt, line.serverAt))
        }
        if (!unread) {
            return@synchronized if (cancelUnlessHeldLocked(conversationId, banner, kept, holds, repost, cancel)) {
                Delivery.CANCELLED
            } else {
                Delivery.KEPT_UNTIL_READ
            }
        }
        val rebuilt = repost(banner, kept) ?: return@synchronized Delivery.NOT_REBUILT
        postedLocked(conversationId, rebuilt)
        Delivery.REPOSTED
    }

    /**
     * Quick reply [messageId] was ANSWERED - delivered while its handler ran: the user answered from
     * the banner, and answering is reading UP TO WHAT THE BANNER SHOWED. [watermark] - the instants
     * the reply's own read watermark announces - is recorded as a mark, so every peer line it covers
     * is READ from now on (a later read weighs it as covered); a message that arrived while the reply
     * was being sent is newer than the watermark and stays unread (round-11 review, principle 2).
     *
     * THE CONVERSATION KEEPS ITS HISTORY (owner, 2026-11-26): a banner that stays shows the lines it
     * showed - the message answered included, read or not - then the answer as this account's own
     * line ([ownLine], covered by any read), like every messaging app. Only this reply's own pending
     * line goes (the answer stands for it); an earlier answer, and ANOTHER reply's pending line still
     * queued, stay. At most [maxLines] lines are drawn, the newest - the bound every post applies.
     * Re-posting the answer ALONE, which is what this did until then, showed "Vous" over nothing on
     * the Android 15+ banner the platform holds after an inline answer: the message answered was gone.
     *
     * What stays is posted the standard way, silently ([repost]), and the record holds exactly that.
     * With nothing UNREAD left (every peer line covered, no other reply pending) the banner is
     * cancelled instead - unless the platform [holds] it (Android 15+, answered inline: a cancel would
     * be dropped, see the class comment), when the update with the history and the answer is what
     * ends the hold and it stays recorded ([Delivery.KEPT_UNTIL_READ]) for the next event. With no
     * banner known - dismissed, or removed by this process - nothing is drawn: no history is
     * resurrected for a conversation the user put away, and [stableId] is cancelled. All in one
     * critical section with the record.
     */
    fun answerReply(
        conversationId: String,
        messageId: String,
        watermark: List<Read>,
        stableId: Int?,
        shade: () -> Banner<M>?,
        holds: (notifId: Int) -> Boolean,
        ownLine: (held: Banner<M>) -> M?,
        repost: (held: Banner<M>, kept: List<M>) -> Banner<M>?,
        cancel: (notifId: Int) -> Unit,
        maxLines: Int,
    ): Delivery = synchronized(lock) {
        watermark.forEach { recordLocked(conversationId, it) }
        val banner = bannerOfLocked(conversationId, shade)
        if (banner == null) {
            if (stableId != null) cancelUnlessHeldUnknownLocked(stableId, holds, cancel)
            return@synchronized Delivery.NONE
        }
        // The history the banner showed, without this reply's own pending line: the answer replaces it.
        val history = banner.messages.filterNot { lineOf(it).pendingReplyId == messageId }
        // What keeps the banner up: a peer line the watermark does not cover, or another reply queued.
        val unread = history.any {
            val line = lineOf(it)
            !line.own && (line.pendingReply || !coversLocked(conversationId, line.sentAt, line.serverAt))
        }
        val held = holds(banner.notifId)
        if (!unread && !held) {
            cancel(banner.notifId)
            withdrawnLocked(conversationId)
            return@synchronized Delivery.CANCELLED
        }
        val shown = (history + listOfNotNull(ownLine(banner))).takeLast(maxLines)
        if (shown.isEmpty()) {
            // Held (an unheld one was cancelled above), and nothing to show: re-posted EMPTY, kept.
            // The `held` already read decides - the platform is not asked twice.
            postedLocked(conversationId, repost(banner, emptyList()) ?: banner)
            return@synchronized Delivery.KEPT_UNTIL_READ
        }
        val rebuilt = repost(banner, shown) ?: return@synchronized Delivery.NOT_REBUILT
        postedLocked(conversationId, rebuilt)
        if (held) Delivery.KEPT_UNTIL_READ else Delivery.REPOSTED
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
     * The conversation ENDED (deleted, left, excluded, its salon or community gone): its banner goes
     * UNCONDITIONALLY - whatever it holds, a pending reply, a line with no server instant, a banner
     * the platform holds after an inline answer - and the record forgets the conversation, its mark
     * included. NO MARK IS RECORDED: an ending is not a read, and a mark is a process-lifetime
     * fact that suppresses later posts, so a conversation the account comes back to (a rejoin, a
     * sign-in after a sign-out) must start from nothing.
     *
     * Both the recorded banner's id and [stableId] are cancelled - a cancel by id is ordered after
     * its `notify` by the system, so a banner posted just before this cannot outlive it.
     *
     * @return the ids cancelled.
     */
    fun end(conversationId: String, stableId: Int?, cancel: (notifId: Int) -> Unit): List<Int> =
        synchronized(lock) {
            val cancelled = linkedSetOf<Int>()
            posted[conversationId]?.let { cancelled += it.notifId }
            if (stableId != null) cancelled += stableId
            for (id in cancelled) cancel(id)
            marks.remove(conversationId)
            withdrawnLocked(conversationId)
            cancelled.toList()
        }

    /**
     * Drops every record and cancels each recorded banner and reaction notification BY ID, under the
     * lock: the account that owned them SIGNED OUT, and nothing it showed may reach the next one. The
     * caller's sweep of the shade misses what was posted just before it (the shade lags a `notify`),
     * and once this returns the shade is never asked again - the system orders a cancel by id after
     * its `notify`, so the recorded ids are the ones that cannot be missed. Marks go too: they are
     * the previous account's reads.
     *
     * @return the ids cancelled.
     */
    fun clear(cancel: (notifId: Int) -> Unit): List<Int> = synchronized(lock) {
        val cancelled = mutableListOf<Int>()
        for (banner in posted.values) {
            cancel(banner.notifId)
            cancelled += banner.notifId
        }
        for (reactionId in reactionsPostedSinceSweep.values) {
            cancel(reactionId)
            cancelled += reactionId
        }
        posted.clear()
        marks.clear()
        withdrawn.clear()
        allWithdrawn = true
        reactionsWithdrawn.clear()
        reactionsPostedSinceSweep.clear()
        reactionsSwept = true
        cancelled
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

    /**
     * Cancels [banner] and forgets it - unless the platform [holds] it, when it is posted again with
     * [shown] ([repost], silent: the update that ends the hold) and STAYS recorded with what that
     * post shows (the class comment's rule). [shown] is what the caller left on it - never a line it
     * just removed (round-14 review: a delivered reply's pending line). With no line, [repost] posts
     * an EMPTY conversation (rebuildBanner), which ends the hold just the same. A banner that cannot
     * be rebuilt (no template) stays recorded AS IT WAS - nothing was posted, so the record must not
     * claim [shown] - and [repost] reports it at WARN; the next event asks again.
     *
     * @return whether [cancel] ran.
     */
    private fun cancelUnlessHeldLocked(
        conversationId: String,
        banner: Banner<M>,
        shown: List<M>,
        holds: (notifId: Int) -> Boolean,
        repost: (held: Banner<M>, kept: List<M>) -> Banner<M>?,
        cancel: (notifId: Int) -> Unit,
    ): Boolean {
        if (holds(banner.notifId)) {
            postedLocked(conversationId, repost(banner, shown) ?: banner)
            return false
        }
        cancel(banner.notifId)
        withdrawnLocked(conversationId)
        return true
    }

    /**
     * Cancels [notifId] - a conversation's stable id, for a banner the record does not know - unless
     * the platform [holds] it: that cancel would be dropped and re-extend it, and with no record
     * there is nothing to re-post, so it is left as it is and reported.
     */
    private fun cancelUnlessHeldUnknownLocked(notifId: Int, holds: (notifId: Int) -> Boolean, cancel: (notifId: Int) -> Unit) {
        if (holds(notifId)) {
            warn("held banner id=$notifId is not recorded - not cancelled, left for the next post or the user")
            return
        }
        cancel(notifId)
    }

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
