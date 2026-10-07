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
 *
 * Nothing Android may be imported here (see [PushRecoveryLadder]). The caller serialises the
 * check-and-post sections with one lock; this class only holds the arithmetic.
 */
class GenericBannerLedger {
    private val inFlight = HashMap<String, Int>()
    private val credits = HashMap<String, Int>()
    private val generics = HashMap<String, ArrayDeque<Long>>()

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
        if (credit <= 0) return false
        if (credit == 1) credits.remove(groupId) else credits[groupId] = credit - 1
        return true
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
        }
        return taken
    }
}
