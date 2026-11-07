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
 *   [inOrder] runs it straight away, under no new ticket.
 *
 * THE BOUND, BY CONSTRUCTION, IN AWAKE TIME: every wake ticket is settled at most [deadlineMs] after
 * it arrived, whether its fetch is queued, running or stuck, because the deadline is scheduled at
 * arrival and does not wait for the fetch to start. So a push is released at most [deadlineMs] after
 * the LATEST arrival among the wakes ahead of it - never "N stalled wakes times the fetch timeout".
 * The clock is the scheduler's (production: `System.nanoTime`, which does not advance while the
 * device is in deep sleep), so the bound is counted in time the CPU is awake: a running fetch holds a
 * wake lock and keeps it awake; a deep sleep with nothing holding one pauses the deadline and the
 * work alike, and nothing is released early. If the deadline cannot even be SCHEDULED, the ticket is
 * settled at once with its deadline action - no ticket is ever left without a way to settle.
 * A fetch that returns after its ticket was settled finds [settle] answering `null`.
 *
 * Actions run in ticket order under this object's monitor, so two settlements can never interleave
 * theirs; an action that throws does not strand the ones behind it. No action may WAIT on the order.
 * Work an action hands to the lane goes through [handOff]: within one release batch, every action
 * runs BEFORE any of their hand-offs does, so whatever an action counts on its way to the lane
 * ([WELCOMES_ON_LANE]-style bookkeeping) is counted for the whole batch before the lane can start
 * running any of it.
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see [PushRecoveryLadder]).
 *
 * @param deadlineMs How long after its arrival a wake ticket may stay unsettled, in awake time.
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

    /** The hand-offs of the release batch THIS thread is running, or null outside one. */
    private val batch = ThreadLocal<MutableList<() -> Unit>?>()

    /**
     * A wake-up push arrives: its ticket, in arrival order, with its deadline scheduled NOW. Unless
     * [settle] came first, [onDeadline] is what the ticket is settled with [deadlineMs] from now -
     * or at once, if the deadline could not be scheduled.
     *
     * @param onScheduleFailed Told why the deadline could not be scheduled, for the caller's log.
     */
    fun arrive(onScheduleFailed: (Throwable) -> Unit = {}, onDeadline: () -> Unit): Long {
        val ticket = synchronized(this) { nextTicket++ }
        try {
            schedule(deadlineMs) { settle(ticket, onDeadline) }
        } catch (e: Throwable) {
            // A ticket with no deadline would rest on its fetch alone, and every push behind it with
            // it. Settled now: the wake is not loaded, and nothing behind it waits.
            onScheduleFailed(e)
            settle(ticket, onDeadline)
        }
        return ticket
    }

    /**
     * Settles [ticket] with [action] - the FIRST settlement wins - and runs every action now at the
     * head, in ticket order, under this object's monitor; then every hand-off they made, in order.
     *
     * @return how many actions ran (0 while an earlier ticket is still out), or `null` when the
     *   ticket was already settled - a late fetch after its deadline - and [action] was dropped.
     */
    @Synchronized
    fun settle(ticket: Long, action: () -> Unit): Int? {
        require(ticket < nextTicket) { "ticket $ticket was never handed out" }
        if (ticket < nextToRelease || settled.containsKey(ticket)) return null
        settled[ticket] = action
        val outermost = batch.get() == null
        if (outermost) batch.set(mutableListOf())
        var released = 0
        // One action that throws must not strand the ones behind it: the loop runs to the end and
        // the first failure is rethrown after it, for the caller to log.
        var failure: Throwable? = null
        try {
            while (true) {
                val head = settled.remove(nextToRelease) ?: break
                nextToRelease++
                released++
                try {
                    head()
                } catch (e: Throwable) {
                    if (failure == null) failure = e
                }
            }
        } finally {
            if (outermost) {
                val handOffs = batch.get().orEmpty()
                batch.set(null)
                for (handOff in handOffs) {
                    try {
                        handOff()
                    } catch (e: Throwable) {
                        if (failure == null) failure = e
                    }
                }
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
        if (batch.get() != null) {
            action()
            return true
        }
        synchronized(this) {
            val ticket = nextTicket++
            settle(ticket, action)
            return ticket < nextToRelease
        }
    }

    /**
     * Hands [task] to the lane: at the END of the current release batch when called from one, so
     * every released action has run (and counted what it counts) before the lane sees any of their
     * work; at once otherwise.
     */
    fun handOff(task: () -> Unit) {
        val pending = batch.get()
        if (pending != null) pending += task else task()
    }

    /** How many tickets are out and not yet released (for the log line). */
    @Synchronized
    fun waiting(): Long = nextTicket - nextToRelease
}
