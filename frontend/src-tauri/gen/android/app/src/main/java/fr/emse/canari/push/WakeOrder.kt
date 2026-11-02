package fr.emse.canari.push

import java.util.TreeMap

/**
 * ARRIVAL ORDER, FOR EVERY PUSH BOUND FOR THE MLS LANE - WAKE-UP OR FULL
 * (docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md).
 *
 * The lane is the device's single writer of `mls.bin`, and the order it runs work in is load-bearing:
 * a key-group Welcome must be joined before the salon push sealed on that group is opened (NOTIF-21),
 * a commit applied before the message sealed after it. A full push used to reach the lane the moment
 * it arrived; a wake-up push reaches it only once its fetch returns - so, unordered, a full `channel`
 * push arriving AFTER a wake whose fetch is still out would run FIRST.
 *
 * So every push takes a ticket ON ARRIVAL, and nothing reaches the lane but in ticket order:
 *
 * - a full push: [inOrder] - a ticket taken and completed at once; it is released as soon as every
 *   earlier ticket is;
 * - a wake-up push: [take] on arrival, [complete] when its fetch returns, whatever it returned;
 * - work queued from INSIDE a release (the fetched frame's own dispatch) is already in its turn:
 *   [inOrder] hands it straight to the lane, under no new ticket.
 *
 * Releases run under this object's monitor, so two completions can never interleave theirs.
 *
 * TERMINATION IS A PROOF, NOT A CLOCK: a ticket is held up only by an earlier wake whose fetch has
 * not returned; every fetch returns within its overall deadline (`WAKE_FETCH_DEADLINE_MS`), and its
 * ticket is completed on EVERY path - the fetch thread's `finally`, and the arrival thread itself if
 * the fetch could not even be scheduled.
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see [PushRecoveryLadder]).
 */
class WakeOrder {
    private var nextTicket = 0L
    private var nextToRelease = 0L
    private val completed = TreeMap<Long, () -> Unit>()

    /** Whether THIS thread is running a release right now. */
    private val releasing = ThreadLocal.withInitial { false }

    /** The next ticket, in arrival order. */
    @Synchronized
    fun take(): Long = nextTicket++

    /**
     * Records [action] as ticket [ticket]'s result and hands every action now at the head to
     * [release], in ticket order, under this object's monitor.
     *
     * @return how many actions were released by this call (0 while an earlier ticket is still out).
     */
    @Synchronized
    fun complete(ticket: Long, action: () -> Unit, release: (() -> Unit) -> Unit): Int {
        require(ticket in nextToRelease until nextTicket) { "ticket $ticket was not handed out or was already released" }
        require(!completed.containsKey(ticket)) { "ticket $ticket completed twice" }
        completed[ticket] = action
        var released = 0
        // One action that throws must not strand the ones behind it: the loop runs to the end and
        // the first failure is rethrown after it, for the caller to log.
        var failure: Throwable? = null
        while (true) {
            val head = completed.remove(nextToRelease) ?: break
            nextToRelease++
            released++
            val outer = releasing.get() == true
            releasing.set(true)
            try {
                release(head)
            } catch (e: Throwable) {
                if (failure == null) failure = e
            } finally {
                releasing.set(outer)
            }
        }
        failure?.let { throw it }
        return released
    }

    /**
     * A push that needs no fetch: released in arrival order - at once when nothing earlier is out,
     * after the earlier wakes otherwise. Called from inside a release, it is already in its turn and
     * goes straight to [release].
     *
     * @return true when [action] was released by this call, false when it waits on an earlier ticket.
     */
    fun inOrder(action: () -> Unit, release: (() -> Unit) -> Unit): Boolean {
        if (releasing.get() == true) {
            release(action)
            return true
        }
        synchronized(this) {
            val ticket = take()
            complete(ticket, action, release)
            return ticket < nextToRelease
        }
    }

    /** How many tickets are out and not yet released (for the log line). */
    @Synchronized
    fun waiting(): Long = nextTicket - nextToRelease
}
