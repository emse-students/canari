package fr.emse.canari.push

/**
 * WHICH GENERIC BANNER IS THE SAME MESSAGE AS WHICH REAL ONE, AS A PURE STATE MACHINE (NOTIF-10, b).
 *
 * A visible push that MLS refused for good (`SecretReuse`) means ANOTHER ENGINE - the WebView's,
 * alive but backgrounded - already holds that generation, and it posts the real banner itself
 * through `notifyMessageFromWebSocket`. The push still posts a generic "nouveau message" line,
 * because it cannot know the other engine will. The two then sit side by side for one message
 * (measured on the Mi 9T, 2026-10-06: the real line landed 56 ms BEFORE the generic one).
 *
 * This ledger pairs them, whichever arrives first, with no clock - only counts bounded by what is
 * actually in flight:
 *  - generic first: its MessagingStyle instant is remembered; the real post takes it and REPLACES it;
 *  - real first: a credit is kept, but only while a push for that group is still in flight, and the
 *    refused push that finds it posts nothing. A real post with no push behind it (the ACK won the
 *    race, nothing was ever pushed) leaves no credit, so it can never swallow a later generic banner.
 *  - ONE REAL POST CAN STAND FOR N MESSAGES (a catch-up flush raises one banner for the last of N),
 *    so it answers up to N pushes - generic lines and credits alike - not one.
 *  - A REAL POST NO PUSH WAS WAITING FOR IS REMEMBERED, BOUNDED (2026-10-09). With the push channel
 *    cut, five messages each got their own real banner and the pushes arrived ~9 minutes later,
 *    all refused: no push was in flight when the real posts landed, so they left no credit and the
 *    refused pushes posted a generic line nothing replaced (NOTIF-10 `FAIL` on #1550, Mi 9T,
 *    2026-10-07). A refusal PROVES the other engine held that generation, so a real banner for the
 *    group exists or is being posted; the refused push therefore consumes one UNCLAIMED real post
 *    when it has no credit. Capped at [MAX_UNCLAIMED] per group, and forgotten when the group's
 *    notification is cancelled ([groupCleared]) - never by a clock.
 *
 * Nothing Android may be imported here (see [PushRecoveryLadder]). The caller serialises the
 * check-and-post sections with one lock; this class only holds the arithmetic.
 */
class GenericBannerLedger {
    private val inFlight = HashMap<String, Int>()
    private val credits = HashMap<String, Int>()
    private val unclaimed = HashMap<String, Int>()
    private val generics = HashMap<String, ArrayDeque<Long>>()

    companion object {
        /**
         * Most real posts remembered per group for a later refused push. A notification stack of one
         * conversation never usefully holds more, and a bound is what keeps a group whose pushes
         * never come (every real post an ACK-won race) from remembering for ever.
         */
        const val MAX_UNCLAIMED = 8
    }

    /** A visible push for [groupId] was received and is queued or running. */
    @Synchronized
    fun pushQueued(groupId: String) {
        inFlight.merge(groupId, 1, Int::plus)
    }

    /** That push is finished; credits beyond what is still in flight can never be claimed. */
    @Synchronized
    fun pushFinished(groupId: String) {
        val left = maxOf((inFlight[groupId] ?: 0) - 1, 0)
        if (left > 0) inFlight[groupId] = left else inFlight.remove(groupId)
        val credit = credits[groupId] ?: 0
        if (credit > left) {
            if (left > 0) credits[groupId] = left else credits.remove(groupId)
        }
    }

    /**
     * The refused push is about to post its generic banner. True when a real post already landed
     * for it, so the generic one must NOT be posted (the credit is consumed).
     */
    @Synchronized
    fun refusedCoveredByRealPost(groupId: String): Boolean {
        val credit = credits[groupId] ?: 0
        if (credit > 0) {
            if (credit == 1) credits.remove(groupId) else credits[groupId] = credit - 1
            return true
        }
        val orphan = unclaimed[groupId] ?: 0
        if (orphan <= 0) return false
        if (orphan == 1) unclaimed.remove(groupId) else unclaimed[groupId] = orphan - 1
        return true
    }

    /**
     * The group's notification was cancelled (read, answered, or the app opened): the real posts it
     * stood for are gone, so none may cover a later refused push. Clears credits and unclaimed
     * posts; generic stamps stay, they are replaced by identity and a cancelled one is a no-op.
     */
    @Synchronized
    fun groupCleared(groupId: String) {
        credits.remove(groupId)
        unclaimed.remove(groupId)
    }

    /** Every notification was cancelled (the app came to the foreground): see [groupCleared]. */
    @Synchronized
    fun allCleared() {
        credits.clear()
        unclaimed.clear()
    }

    /** The generic banner reached the shade with MessagingStyle instant [stamp]. */
    @Synchronized
    fun genericPosted(groupId: String, stamp: Long) {
        generics.getOrPut(groupId) { ArrayDeque() }.addLast(stamp)
    }

    /**
     * The WebView is about to post ONE real banner for [groupId] standing for [covers] messages (1
     * for a live frame, N for a catch-up flush, which raises a single banner for the last of N).
     * The server may have pushed each of those N messages, so the post answers up to N pushes:
     * measured on the Mi 9T, 2026-10-06, one banner (`messages=5`) met three refused pushes and a
     * ledger that paired one post with one push left a generic line behind.
     *
     * Returns the instants of the generic lines it must replace (oldest first, at most [covers]).
     * Whatever part of [covers] no generic line absorbed becomes credits for refused pushes still
     * in flight, capped by those in flight so a post with no push behind it - the ACK won the race -
     * leaves nothing to swallow a later generic banner.
     */
    @Synchronized
    fun realPosted(groupId: String, covers: Int): List<Long> {
        val taken = ArrayList<Long>()
        val queue = generics[groupId]
        while (taken.size < covers && queue != null && queue.isNotEmpty()) {
            taken.add(queue.removeFirst())
        }
        if (queue != null && queue.isEmpty()) generics.remove(groupId)
        val unmatched = covers - taken.size
        if (unmatched > 0) {
            val waiting = inFlight[groupId] ?: 0
            val credit = credits[groupId] ?: 0
            val granted = minOf(unmatched, maxOf(waiting - credit, 0))
            if (granted > 0) credits[groupId] = credit + granted
            // What no push claimed is not dropped: a push that comes LATER and is refused for good
            // proves this banner exists (see the class comment).
            val orphaned = unmatched - granted
            if (orphaned > 0) {
                unclaimed[groupId] = minOf((unclaimed[groupId] ?: 0) + orphaned, MAX_UNCLAIMED)
            }
        }
        return taken
    }
}
