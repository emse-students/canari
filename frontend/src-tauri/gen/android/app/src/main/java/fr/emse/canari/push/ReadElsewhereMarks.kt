package fr.emse.canari.push

/**
 * HOW FAR THIS ACCOUNT HAS READ EACH CONVERSATION ON ANOTHER DEVICE, as the WebView learned it
 * over its socket (2026-11-20) - the fact a post has to be checked against, so that the order in
 * which a message's banner and the read covering it reach the native side decides nothing.
 *
 * WHY A RECORD AND NOT JUST A CANCEL. The WebView's post of a message is asynchronous before it
 * reaches Kotlin (the sender's name is resolved and the name files flushed first), while the read
 * covering it may be handed over at once. A cancel that lands first finds nothing to remove, and the
 * post that follows would put up a banner for a message already read - for good. So a read RECORDS
 * its mark - always, even when something newer stays unread and nothing is cancelled - and every
 * post asks it: a message at or below the mark is not posted, whichever arrived first.
 *
 * THE SHADE DECIDES THE CANCEL, NOT THE WEBVIEW'S ROW. A read removes the conversation's banner
 * only when its mark covers EVERY line that banner holds, compared on the same clock rule as a post
 * ([covers]). The WebView's row can lag behind the shade - a frozen WebView drains an own read from
 * before a message the push already announced, and its row, which has not received that message
 * yet, counts nothing unread - so "nothing unread here" is not the fact; the lines in the shade, and
 * the instants this side stamped on them, are (re-review of #3912, 2026-11-20).
 *
 * ONE LOCK, OWNED HERE, and the two halves that must not interleave both run inside it:
 * [recordThenCancel] (a read: record, then remove the banner) and [postUnlessRead] (a post: check,
 * then EVERY side effect of the post - the channel-switch cancel of the previous banner as much as
 * the `notify`). Whichever takes it first, the other sees its effect: a post first is then
 * cancelled, a read first stops the post before it touches the shade. It is a LEAF lock: the
 * actions run inside it are binder calls to the notification manager, never another of the app's
 * locks.
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

    /** A read as the WebView hands it over: the instant, and whether it is on the server's clock. */
    data class Read(val at: Long, val serverClock: Boolean)

    /**
     * One line of a conversation's notification, as this side stamped it when it posted it: the
     * sender's instant and the server's (0 when unknown).
     */
    data class Line(val sentAt: Long, val serverAt: Long)

    private val lock = Any()

    /** Guarded by [lock]. */
    private val marks = HashMap<String, Mark>()

    /**
     * Raises [conversationId]'s mark to [read]'s instant, on its clock. A lower or non-positive
     * instant changes nothing.
     */
    fun record(conversationId: String, read: Read) {
        synchronized(lock) { recordLocked(conversationId, read) }
    }

    /**
     * Records [read], then reads the conversation's notification ([shadeLines]: its lines, or null
     * when none is posted) and runs [cancel] only when the mark covers EVERY line - all in ONE
     * critical section, so no post can fall between them: one that checked before the record has
     * already posted and its line is weighed here, one that checks after it sees the mark.
     *
     * A line the mark does not cover - a message newer than the read, or one comparable on neither
     * clock - keeps the banner: it is a message this account has not read. A notification with no
     * stamped line is covered (nothing in it is news this side announced).
     *
     * @return whether [cancel] ran.
     */
    fun recordThenCancel(
        conversationId: String,
        read: Read,
        shadeLines: () -> List<Line>?,
        cancel: () -> Unit,
    ): Boolean = synchronized(lock) {
        recordLocked(conversationId, read)
        val lines = shadeLines() ?: return@synchronized false
        if (lines.all { coversLocked(conversationId, it.sentAt, it.serverAt) }) {
            cancel()
            true
        } else {
            false
        }
    }

    /**
     * Runs [post] - EVERY side effect a post has on the shade, the removal of the previous banner
     * included - only when the message is not covered by a read, in one critical section with the
     * check. A covered message touches nothing: removing the conversation's current banner for a
     * message that is then not posted would take a newer message's banner down with it.
     *
     * @return whether [post] ran.
     */
    fun postUnlessRead(conversationId: String, sentAt: Long, serverAt: Long, post: () -> Unit): Boolean =
        synchronized(lock) {
            if (coversLocked(conversationId, sentAt, serverAt)) {
                false
            } else {
                post()
                true
            }
        }

    /** The mark held for [conversationId], or null. */
    fun of(conversationId: String): Mark? = synchronized(lock) { marks[conversationId] }

    /**
     * Whether a message stamped [sentAt] by its sender and accepted by the server at [serverAt]
     * (0 when unknown) has already been read elsewhere. The early, side-effect-free question a post
     * asks before it builds anything; the answer that decides is [postUnlessRead]'s.
     *
     * On the server clock when both the message and the mark carry it; else on the stamped clock
     * when both carry that. A message that can be compared on neither is NOT covered: a banner for a
     * read message is noise, a lost banner for an unread one is a lost message.
     */
    fun covers(conversationId: String, sentAt: Long, serverAt: Long): Boolean =
        synchronized(lock) { coversLocked(conversationId, sentAt, serverAt) }

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
