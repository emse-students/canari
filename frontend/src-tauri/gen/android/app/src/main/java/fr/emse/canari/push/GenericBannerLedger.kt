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
     * The WebView is about to post the real banner for [groupId]. Returns the instant of the
     * generic line it must replace, or 0 when there is none - in which case a credit is kept for a
     * refused push still in flight.
     */
    @Synchronized
    fun realPosted(groupId: String): Long {
        val queue = generics[groupId]
        if (queue != null && queue.isNotEmpty()) {
            val stamp = queue.removeFirst()
            if (queue.isEmpty()) generics.remove(groupId)
            return stamp
        }
        val waiting = inFlight[groupId] ?: 0
        val credit = credits[groupId] ?: 0
        if (credit < waiting) credits[groupId] = credit + 1
        return 0L
    }
}
