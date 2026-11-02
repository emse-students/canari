package fr.emse.canari.push

import java.util.TreeMap

/**
 * WAKE-UP FETCHES RUN TOGETHER, AND THEIR FRAMES ARE RELEASED IN THE ORDER FCM DELIVERED THEM
 * (docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md).
 *
 * The fetch is network I/O; the MLS push lane is the device's single writer of `mls.bin`. Fetching ON
 * the lane held every frame behind it for a round trip each - a burst of ten wakes was ten serial
 * round trips before the first decrypt. So the fetch runs off the lane, and this reorder buffer is
 * what keeps the property the lane gave for free: frame A, delivered before frame B, is DISPATCHED
 * before B even when B's fetch returns first (an MLS commit and the message sealed after it are
 * exactly such a pair).
 *
 * - [take] is called on arrival, in delivery order, and hands out consecutive tickets.
 * - [complete] records what one fetch became and returns, in ticket order, every completed action
 *   that is now at the head - the caller hands them to the lane in that order, while still holding
 *   the guarantee that nobody else releases in between (it runs them under this object's monitor).
 *
 * TERMINATION IS A PROOF, NOT A CLOCK: a ticket is held up only by an earlier ticket whose fetch has
 * not returned, and every fetch returns - its socket has a connect and a read timeout, and every
 * path through it, the exceptions included, ends in [complete]. A ticket that never completed would
 * hold every later wake; that is why the caller completes it in a `finally`.
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see [PushRecoveryLadder]).
 */
class WakeOrder {
    private var nextTicket = 0L
    private var nextToRelease = 0L
    private val completed = TreeMap<Long, () -> Unit>()

    /** The next ticket, in delivery order. */
    @Synchronized
    fun take(): Long = nextTicket++

    /**
     * Records [action] as ticket [ticket]'s result and hands every action now at the head to
     * [release], in ticket order, under this object's monitor - so two fetches completing at once
     * can never interleave their releases.
     *
     * @return how many actions were released by this call (0 while an earlier ticket is still out).
     */
    @Synchronized
    fun complete(ticket: Long, action: () -> Unit, release: (() -> Unit) -> Unit): Int {
        require(ticket in nextToRelease until nextTicket) { "ticket $ticket was not handed out or was already released" }
        require(!completed.containsKey(ticket)) { "ticket $ticket completed twice" }
        completed[ticket] = action
        var released = 0
        while (true) {
            val head = completed.remove(nextToRelease) ?: break
            nextToRelease++
            release(head)
            released++
        }
        return released
    }

    /** How many tickets are out and not yet released (for the log line). */
    @Synchronized
    fun waiting(): Long = nextTicket - nextToRelease
}
