package fr.emse.canari.push

import java.util.TreeMap

/**
 * ARRIVAL ORDER, FOR EVERY PUSH BOUND FOR THE MLS LANE - WAKE-UP OR FULL - WITHIN A BOUND
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
 * - a full push, or new work a lane task spawns: [inOrder] - a ticket taken and settled at once;
 * - a wake-up push: [arrive], settled by whichever comes first - its fetch's result ([settle]) or
 *   its deadline, [deadlineMs] after ARRIVAL, which settles it with the action given to [arrive];
 * - work queued from INSIDE a release (the fetched frame's own dispatch) is already in its turn:
 *   [inOrder] hands it straight on, under no new ticket.
 *
 * THE BOUND, BY CONSTRUCTION: every wake ticket is settled at most [deadlineMs] after it arrived,
 * whether its fetch is queued, running or stuck, because the deadline is scheduled at arrival and
 * does not wait for the fetch to start. So a push is released at most [deadlineMs] after the LATEST
 * arrival among the wakes ahead of it - never "N stalled wakes times the fetch timeout". A fetch
 * that returns after its ticket was settled finds [settle] answering `null`: its result is dropped,
 * and the caller logs that.
 *
 * Actions run in ticket order under this object's monitor, so two settlements can never interleave
 * theirs; an action that throws does not strand the ones behind it. No action may WAIT on the order.
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see [PushRecoveryLadder]).
 *
 * @param deadlineMs How long after its arrival a wake ticket may stay unsettled.
 * @param schedule Runs a task once, `delayMs` from now (production: a single-thread scheduled
 *   executor; tests: a recorder they fire by hand, so no test asserts a wall clock).
 */
class WakeOrder(
    private val deadlineMs: Long,
    private val schedule: (delayMs: Long, task: () -> Unit) -> Unit,
) {
    private var nextTicket = 0L
    private var nextToRelease = 0L
    private val settled = TreeMap<Long, () -> Unit>()

    /** Whether THIS thread is running a release right now. */
    private val releasing = ThreadLocal.withInitial { false }

    /**
     * A wake-up push arrives: its ticket, in arrival order, with its deadline scheduled NOW. Unless
     * [settle] came first, [onDeadline] is what the ticket is settled with [deadlineMs] from now.
     */
    fun arrive(onDeadline: () -> Unit): Long {
        val ticket = synchronized(this) { nextTicket++ }
        schedule(deadlineMs) { settle(ticket, onDeadline) }
        return ticket
    }

    /**
     * Settles [ticket] with [action] - the FIRST settlement wins - and runs every action now at the
     * head, in ticket order, under this object's monitor.
     *
     * @return how many actions ran (0 while an earlier ticket is still out), or `null` when the
     *   ticket was already settled - a late fetch after its deadline - and [action] was dropped.
     */
    @Synchronized
    fun settle(ticket: Long, action: () -> Unit): Int? {
        require(ticket < nextTicket) { "ticket $ticket was never handed out" }
        if (ticket < nextToRelease || settled.containsKey(ticket)) return null
        settled[ticket] = action
        var released = 0
        // One action that throws must not strand the ones behind it: the loop runs to the end and
        // the first failure is rethrown after it, for the caller to log.
        var failure: Throwable? = null
        while (true) {
            val head = settled.remove(nextToRelease) ?: break
            nextToRelease++
            released++
            val outer = releasing.get() == true
            releasing.set(true)
            try {
                head()
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
     * Work that needs no fetch: run in arrival order - at once when nothing earlier is out, after
     * the earlier wakes otherwise (within their bound). Called from inside a release, it is already
     * in its turn and runs straight away.
     *
     * @return true when [action] ran in this call, false when it waits on an earlier ticket.
     */
    fun inOrder(action: () -> Unit): Boolean {
        if (releasing.get() == true) {
            action()
            return true
        }
        synchronized(this) {
            val ticket = nextTicket++
            settle(ticket, action)
            return ticket < nextToRelease
        }
    }

    /** How many tickets are out and not yet released (for the log line). */
    @Synchronized
    fun waiting(): Long = nextTicket - nextToRelease
}
