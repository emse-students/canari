package fr.emse.canari.push

/**
 * THE QUICK REPLIES WHOSE HANDLER IS STILL RUNNING, and the server's receive time of each once a
 * drain DELIVERED it (round-10 review of #3912) - how the handler learns, from a fact and not from
 * thread scheduling, that ANOTHER drain sent its reply while the user was replying from the banner.
 *
 * WRITTEN UNDER THE OUTBOX LOCK, AT THE SEND. The drain records a delivery here at the moment its
 * POST succeeds, still holding the outbox lock - never later. So every drain that takes the outbox
 * lock after it, the handler's own included, finds the record when it returns: the handler's check
 * after its drain is decided by the lock's order, not by how far the other drain's post-lock loop has
 * got (measured on a Mi 9T: the handler and the retry worker 5 ms apart, the worker's late step ran
 * after the handler had already re-posted the reply as pending). The re-post's own check, under the
 * banner record's lock, then only covers a drain that took the outbox lock after the handler's - a
 * genuinely later delivery, whose late step clears the pending line the re-post put up.
 *
 * ITS OWN LEAF LOCK: taken under the outbox lock (the drain) and under the banner record's lock (the
 * re-post's check), and nothing is ever taken under it - so it adds no order between those two.
 *
 * BOUNDED BY CONSTRUCTION, NOT BY A CAP: an id is added before its entry can reach the outbox (so no
 * drain can deliver it unseen) and removed when its handler ends, so the map holds at most one entry
 * per quick reply in flight - and a delivery of any other message records nothing.
 *
 * IN MEMORY, ON PURPOSE: the handler and the drains it races live in one process. A process that
 * dies between the enqueue and the decision leaves its banner to the next process (backlog
 * `p3-a-quick-reply-whose-process-died-leaves-its-banner-spinning`).
 *
 * No Android import: the JVM test project compiles it.
 */
class AwaitedReplies {
    /** The leaf lock - see the class comment. */
    private val lock = Any()

    /** Guarded by [lock]: reply id -> the server's receive time once delivered, null until then. */
    private val awaited = HashMap<String, Long?>()

    /** A quick reply's handler starts. Called BEFORE its entry is queued, so no delivery is missed. */
    fun await(messageId: String) {
        synchronized(lock) { awaited[messageId] = null }
    }

    /**
     * A drain delivered [messageId], the server answering [receivedAt]: recorded only for an awaited
     * reply. Called by the drain AT THE SEND, under the outbox lock.
     */
    fun delivered(messageId: String, receivedAt: Long) {
        synchronized(lock) { if (awaited.containsKey(messageId)) awaited[messageId] = receivedAt }
    }

    /** The server's receive time of reply [messageId] if a drain delivered it while its handler runs. */
    fun deliveredAt(messageId: String): Long? = synchronized(lock) { awaited[messageId] }

    /** The quick reply's handler ends: [messageId] is no longer awaited. */
    fun settle(messageId: String) {
        synchronized(lock) { awaited.remove(messageId) }
    }
}
