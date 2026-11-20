package fr.emse.canari.push

import java.util.concurrent.ConcurrentHashMap

/**
 * HOW FAR THIS ACCOUNT HAS READ EACH CONVERSATION ON ANOTHER DEVICE, as the WebView learned it
 * over its socket (2026-11-20) - the fact a post has to be checked against, so that the order in
 * which a message's banner and the read covering it reach the native side decides nothing.
 *
 * WHY A RECORD AND NOT JUST A CANCEL. The WebView's post of a message is asynchronous before it
 * reaches Kotlin (the sender's name is resolved and the name files flushed first), while the read
 * covering it may be handed over at once. A cancel that lands first finds nothing to remove, and the
 * post that follows would put up a banner for a message already read - for good. So the dismissal
 * RECORDS the mark, and every post asks it (`showMessageNotification`, under the lock it shares
 * with the dismissal): a message at or below the mark is not posted, whichever arrived first.
 *
 * IN MEMORY, ON PURPOSE. The race it closes is between a post still being built and a read this
 * process was told about; both die with the process. A later process learns the read from its own
 * conversation rows, which `notifyInbound` asks before it raises anything.
 *
 * TWO CLOCKS, as everywhere a mark lives (readState.ts): the server's `createdAt` when the mark is
 * on it (a DM or group mark from this build), the stamped one otherwise (a salon, whose stamp IS its
 * server time, or an older sender's bare `at`). Each only rises.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
class ReadElsewhereMarks {

    /** One conversation's mark on each clock; 0 = not known on that clock. */
    data class Mark(val stamped: Long, val server: Long)

    private val marks = ConcurrentHashMap<String, Mark>()

    /**
     * Raises [conversationId]'s mark to [at], on the server clock when [serverClock], the stamped
     * one otherwise. A lower or non-positive [at] changes nothing.
     */
    fun record(conversationId: String, at: Long, serverClock: Boolean) {
        if (conversationId.isEmpty() || at <= 0L) return
        marks.merge(
            conversationId,
            if (serverClock) Mark(0L, at) else Mark(at, 0L),
        ) { held, add -> Mark(maxOf(held.stamped, add.stamped), maxOf(held.server, add.server)) }
    }

    /** The mark held for [conversationId], or null. */
    fun of(conversationId: String): Mark? = marks[conversationId]

    /**
     * Whether a message stamped [sentAt] by its sender and accepted by the server at [serverAt]
     * (0 when unknown) has already been read elsewhere.
     *
     * On the server clock when both the message and the mark carry it; else on the stamped clock
     * when both carry that. A message that can be compared on neither is NOT covered: a banner for a
     * read message is noise, a lost banner for an unread one is a lost message.
     */
    fun covers(conversationId: String, sentAt: Long, serverAt: Long): Boolean {
        val mark = marks[conversationId] ?: return false
        return when {
            serverAt > 0L && mark.server > 0L -> serverAt <= mark.server
            sentAt > 0L && mark.stamped > 0L -> sentAt <= mark.stamped
            else -> false
        }
    }
}
