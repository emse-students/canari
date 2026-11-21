package fr.emse.canari.push

/**
 * THE QUICK REPLIES HANDED TO THE PAGE, AND WHAT THEIR BANNER SAYS UNTIL THE PAGE SETTLES THEM.
 *
 * A reply typed over the open app is handed to the page (`pending_quick_replies.ndjson`,
 * [QuickReplyRoute.PAGE]). Drawing it "answered" at the hand-over was a claim nothing backed: the
 * page could drop it (typed under another account), die between its take and the send's durable
 * write, or never run (a frozen process). So the receiver RECORDS each reply it hands over and draws
 * it "sending"; the page's settlement (`acknowledge_quick_reply`, the Rust `QuickReplyOutcome`
 * codes) moves the banner ([Settlement]), and a page starting up sweeps the record: a reply recorded
 * but absent from the file was taken by a page that died - LOST, and said ([unclaimed]).
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
object HandedQuickReplies {

    /** One reply the receiver handed over: the record its banner is redrawn from. */
    data class Handed(
        val replyId: String,
        val accountId: String,
        val groupId: String,
        val text: String = "",
        val repliedAt: Long = 0L,
        val notifiedAt: Long = 0L,
        val notifiedServerAt: Long = 0L,
    )

    /** What the page's settlement draws on the banner. */
    enum class Settlement {
        /** Sent, or queued in the page's outbox: durably the page's - the user's own line. */
        ANSWERED,

        /** Out of the page's queue unsent: a failed row the page shows, with its Retry. */
        NOT_SENT_IN_APP,

        /** Put back for a later take: still "sending", the record kept. */
        STILL_SENDING,

        /** Lost (or an outcome nobody knows): nothing will send it - "not sent, retype it". */
        NOT_SENT_RETYPE;

        /** Whether the record ends with this settlement. */
        val settles: Boolean get() = this != STILL_SENDING

        companion object {
            /** The Rust `QuickReplyOutcome` code: 0 sent, 1 failed, 2 pending, 3 returned, 4 lost. */
            fun of(outcome: Int): Settlement = when (outcome) {
                0, 2 -> ANSWERED
                1 -> NOT_SENT_IN_APP
                3 -> STILL_SENDING
                else -> NOT_SENT_RETYPE
            }

            /** Whether [outcome] is a code the page sends; any other is drawn lost and accused. */
            fun known(outcome: Int): Boolean = outcome in 0..4
        }
    }

    /**
     * The replies of [accountId] recorded as handed over and absent from the file ([waiting] - its
     * ids, read under the take's lock): taken by an earlier page life that never settled them.
     * Asked once per account and page life, BEFORE that life's first take, so no reply in flight in
     * a live page can be among them.
     */
    fun unclaimed(records: Collection<Handed>, accountId: String, waiting: Set<String>): List<Handed> =
        records.filter { it.accountId == accountId && it.replyId !in waiting }
}
