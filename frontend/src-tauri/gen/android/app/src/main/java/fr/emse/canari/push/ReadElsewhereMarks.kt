package fr.emse.canari.push

/**
 * HOW FAR THIS ACCOUNT HAS READ EACH CONVERSATION ON ANOTHER DEVICE, as the WebView learned it
 * over its socket, AND WHAT THIS PROCESS HAS POSTED FOR EACH (2026-11-20) - the two facts a post and
 * a read are weighed against, so that the order in which a message's banner and the read covering
 * it reach the native side decides nothing.
 *
 * WHY A RECORD AND NOT JUST A CANCEL. The WebView's post of a message is asynchronous before it
 * reaches Kotlin (the sender's name is resolved and the name files flushed first), while the read
 * covering it may be handed over at once. A cancel that lands first finds nothing to remove, and the
 * post that follows would put up a banner for a message already read - for good. So a read RECORDS
 * its mark - always - and every post asks it: a message at or below the mark is not posted.
 *
 * THE LINES DECIDE THE CANCEL, NOT THE WEBVIEW'S ROW. A read removes the conversation's banner only
 * when its mark covers EVERY line that banner holds, compared on the same clock rule as a post
 * ([covers]). The WebView's row can lag behind the shade - a frozen WebView drains an own read from
 * before a message the push already announced, and its row, which has not received that message
 * yet, counts nothing unread (round-3 review of #3912).
 *
 * THE BANNER IS WHAT THIS PROCESS POSTED, NOT THE SHADE'S ANSWER. `notify` returns before the system
 * has enqueued the record, so the shade read right after a post can still show the notification
 * from BEFORE it. Weighing it, a read would cancel a banner without seeing its newest line (that line
 * lost) or find nothing to cancel (a read banner left standing); re-injecting from it, a second post
 * would drop the first one's line. So every post records the [Banner] it handed to `notify` - its id,
 * its channel, its messages - and both the next post and a read start from that record; the shade
 * ([bannerOf]'s fallback) answers only when this process has posted nothing for the conversation (a
 * fresh process, whose banner an earlier one left). The record goes with the banner: removed by a
 * read ([recordThenCancel]), any other cancel or the user's own dismissal ([forget], [forgetAll]).
 *
 * ONE LOCK, [lock], held by a post from the moment it reads the banner it re-injects to the moment
 * it records what it posted ([showMessageNotification] takes it around that whole section), and by a
 * read across record, weigh and cancel. Whichever takes it first, the other sees its effect. It is
 * reentrant (the methods below take it too). Nothing inside it takes another of the app's locks; a
 * post may already hold the generic-banner lock when it takes this one, never the reverse.
 *
 * IN MEMORY, ON PURPOSE. The races it closes are between a post still being built, a read this
 * process was told about, and the system's own queue; all of them die with the process.
 *
 * TWO CLOCKS, as everywhere a mark lives (readState.ts): the server's `createdAt` when the mark is
 * on it (a DM or group mark from this build), the stamped one otherwise (a salon, whose stamp IS its
 * server time, or an older sender's bare `at`). Each only rises.
 *
 * Generic over the message type [M] so the JVM suite drives it with its own fake messages; [lineOf]
 * says what each message counts as. Compiled by the JVM test project too, so nothing here may import
 * Android - see [PushRecoveryLadder] for why that is the guard.
 */
class ReadElsewhereMarks<M>(private val lineOf: (M) -> Line?) {

    /** One conversation's mark on each clock; 0 = not known on that clock. */
    data class Mark(val stamped: Long, val server: Long)

    /** A read as the WebView hands it over: the instant, and whether it is on the server's clock. */
    data class Read(val at: Long, val serverClock: Boolean)

    /**
     * One line of a conversation's notification, as this side stamped it when it posted it: the
     * sender's instant and the server's (0 when unknown, and both 0 for a line that carries no
     * stamp - never covered).
     */
    data class Line(val sentAt: Long, val serverAt: Long) {
        companion object {
            /**
             * The line a message of the notification counts as: none for this account's OWN line
             * (marked so explicitly when it was posted - a reply drawn in the shade is not news), the
             * stamps when it carries them, and an UNCOVERABLE line when it does not - a banner from a
             * build that did not stamp its lines is not proven read by any mark, so it is kept.
             */
            fun of(own: Boolean, sentAt: Long?, serverAt: Long?): Line? = when {
                own -> null
                sentAt == null -> Line(0L, 0L)
                else -> Line(sentAt, serverAt ?: 0L)
            }
        }
    }

    /** A conversation notification as posted: its id, its channel (null below API 26), its messages. */
    data class Banner<M>(val notifId: Int, val channelId: String?, val messages: List<M>)

    /** The one lock - see the class comment. */
    val lock = Any()

    /** Guarded by [lock]. */
    private val marks = HashMap<String, Mark>()

    /** The banner this process last handed to `notify`, per conversation. Guarded by [lock]. */
    private val posted = HashMap<String, Banner<M>>()

    /**
     * Raises [conversationId]'s mark to [read]'s instant, on its clock. A lower or non-positive
     * instant changes nothing.
     */
    fun record(conversationId: String, read: Read) {
        synchronized(lock) { recordLocked(conversationId, read) }
    }

    /**
     * The conversation's banner as a post should build on it and a read should weigh it: what this
     * process last posted, else what [shade] answers (null when nothing is posted there either).
     */
    fun bannerOf(conversationId: String, shade: () -> Banner<M>?): Banner<M>? =
        synchronized(lock) { posted[conversationId] ?: shade() }

    /**
     * Records [read], then weighs the conversation's banner ([bannerOf]) and runs [cancel] with
     * ITS id only when the mark covers EVERY line - all in ONE critical section, so no post can fall
     * between them. A line the mark does not cover - a message newer than the read, or one comparable
     * on neither clock - keeps the banner: it is a message this account has not read. A banner whose
     * every line is this account's own is covered.
     *
     * @return whether [cancel] ran.
     */
    fun recordThenCancel(
        conversationId: String,
        read: Read,
        shade: () -> Banner<M>?,
        cancel: (notifId: Int) -> Unit,
    ): Boolean = synchronized(lock) {
        recordLocked(conversationId, read)
        val banner = posted[conversationId] ?: shade() ?: return@synchronized false
        val lines = banner.messages.map(lineOf)
        if (lines.all { it == null || coversLocked(conversationId, it.sentAt, it.serverAt) }) {
            cancel(banner.notifId)
            posted.remove(conversationId)
            true
        } else {
            false
        }
    }

    /**
     * Runs [post] - EVERY side effect a post has on the shade, the removal of the previous banner
     * included - only when the message is not covered by a read, in one critical section with the
     * check, and records [banner] as what is now posted. A covered message touches nothing:
     * removing the conversation's current banner for a message that is then not posted would take a
     * newer message's banner down with it.
     *
     * @return whether [post] ran.
     */
    fun postUnlessRead(
        conversationId: String,
        sentAt: Long,
        serverAt: Long,
        banner: Banner<M>,
        post: () -> Unit,
    ): Boolean = synchronized(lock) {
        if (coversLocked(conversationId, sentAt, serverAt)) {
            false
        } else {
            post()
            posted[conversationId] = banner
            true
        }
    }

    /** Records [banner] as posted for [conversationId], for a post that is not a message (an own line). */
    fun remember(conversationId: String, banner: Banner<M>) {
        synchronized(lock) { posted[conversationId] = banner }
    }

    /** Drops what this process posted for [conversationId]: its banner was removed another way. */
    fun forget(conversationId: String) {
        synchronized(lock) { posted.remove(conversationId) }
    }

    /** Drops every record: every message banner was removed at once (the app came to the front). */
    fun forgetAll() {
        synchronized(lock) { posted.clear() }
    }

    /** The mark held for [conversationId], or null. */
    fun of(conversationId: String): Mark? = synchronized(lock) { marks[conversationId] }

    /**
     * Whether a message stamped [sentAt] by its sender and accepted by the server at [serverAt]
     * (0 when unknown) has already been read elsewhere.
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
