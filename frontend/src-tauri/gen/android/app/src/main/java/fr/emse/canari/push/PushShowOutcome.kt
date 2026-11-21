package fr.emse.canari.push

/**
 * WHAT ONE MESSAGE PUSH ENDED IN, AND WHAT THE OS WAS SET TO WHEN IT DID (2026-11-20).
 *
 * A message push can be cached and draw nothing: the app is in the foreground, the member's level
 * withholds it, the foreground engine holds the frame, the reader already read it from the shade,
 * it was already announced and dismissed. And a post can be dropped or silenced by the OS, since
 * `NotificationManager.notify` checks neither the app's switch nor the channel's importance. Each
 * of those was a logcat `Log.d` only, so a member's exported log could not tell "suppressed by
 * design" from "posted" from "posted and dropped by the OS": a full-mode push was cached on
 * 2026-11-20 and no notification was seen, and nothing said why.
 *
 * The read-elsewhere decisions of [ReadElsewhereMarks] - what a read, a dismissal or a delivered
 * reply did to a banner - record the same line, so a banner that went (or stayed) is explained too.
 *
 * So every way a VISIBLE message push ends records ONE line ([line]) into the in-app log, through
 * the push service's recorded-INFO path (`FcmLog.iRecorded`), and that line is a WARN ([level])
 * exactly when the app posted what the OS drops - the one outcome that is a defect to chase rather
 * than a decision to read. [Outcome.recorded] false stays in logcat: a refresh of a line already
 * shown is the second trigger of one message, and recording it would spend the budget on nothing.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard. The OS constants are therefore restated below by
 * value; each is a frozen platform constant (`NotificationManager`, `UsageStatsManager`).
 */
object PushShowOutcome {

    /**
     * Each way a visible message push ends. [posts]: it reached `manager.notify`. [recorded]: the
     * in-app log carries it (else logcat only).
     */
    enum class Outcome(val token: String, val posts: Boolean, val recorded: Boolean = true) {
        /** A first announcement, alerting as its channel says. */
        POSTED("posted", true),
        /** A first announcement posted without its sound, because a call holds it ([CallSoundHold]). */
        POSTED_SILENT_CALL("posted-silent-call", true),
        /** The other trigger already put this message in the shade: refreshed, no second alert. */
        ALREADY_IN_SHADE("already-in-shade", true, recorded = false),
        /** The post replaces a line already announced (a blind banner's decrypted redraw): no alert. */
        REDRAWN("redrawn", true),
        /** The show decision, with the app in the foreground: the WebSocket delivered it to the UI. */
        SUPPRESSED_FOREGROUND("suppressed-foreground", false),
        /** `dispatchPush`'s guard: the app in front handles the frame, nothing decrypted here. */
        SUPPRESSED_FOREGROUND_GUARD("suppressed-foreground-guard", false),
        /** `onWakePush`'s guard: the app in front drains the queue, nothing fetched here. */
        SUPPRESSED_FOREGROUND_WAKE("suppressed-foreground-wake", false),
        /** The decrypt yielded to the foreground engine, which holds the frame and notifies for it. */
        YIELDED("yielded", false),
        /** The member's level for the conversation withholds it ([NotificationLevelGate]); cached. */
        WITHHELD_LEVEL("withheld-level", false),
        /** Refused for good, and the real banner from the engine that holds it is already up. */
        REFUSED_COVERED("refused-covered", false),
        /** The reader already read the conversation up to this message from the shade. */
        SUPPRESSED_SHADE_MARK("suppressed-shade-mark", false),
        /** Already announced, then dismissed (swiped, or cleared by a launch): not announced twice. */
        SUPPRESSED_ALREADY_ALERTED("suppressed-already-alerted", false),
        /** Already read on another device ([ReadElsewhereMarks.covers], or refused at the post). */
        SUPPRESSED_READ_ELSEWHERE("suppressed-read-elsewhere", false),

        // What a read on another device did to the banner ([ReadElsewhereMarks.ReadOutcome]).
        READ_NO_BANNER("read-no-banner", false),
        READ_CANCELLED("read-cancelled", false),
        READ_HELD("read-held", false),
        READ_PENDING_ONLY("read-pending-only", false),
        READ_UNREAD("read-unread", false),

        // What a dismissal with no mark did ([ReadElsewhereMarks.Withdrawal]).
        WITHDRAW_NONE("withdraw-none", false),
        WITHDRAW_KEPT_PENDING_REPLY("withdraw-kept-pending-reply", false),
        WITHDRAW_CANCELLED("withdraw-cancelled", false),
        WITHDRAW_HELD("withdraw-held", false),

        // What a delivered or answered reply did to its banner ([ReadElsewhereMarks.Delivery]).
        DELIVERY_NONE("delivery-none", false),
        DELIVERY_CANCELLED("delivery-cancelled", false),
        DELIVERY_REPOSTED("delivery-reposted", false),
        DELIVERY_NOT_REBUILT("delivery-not-rebuilt", false),
        DELIVERY_KEPT_UNTIL_READ("delivery-kept-until-read", false),
    }

    /** The line of a read on another device, one outcome per [ReadElsewhereMarks.ReadOutcome]. */
    fun of(read: ReadElsewhereMarks.ReadOutcome): Outcome = when (read) {
        ReadElsewhereMarks.ReadOutcome.NO_BANNER -> Outcome.READ_NO_BANNER
        ReadElsewhereMarks.ReadOutcome.CANCELLED -> Outcome.READ_CANCELLED
        ReadElsewhereMarks.ReadOutcome.HELD -> Outcome.READ_HELD
        ReadElsewhereMarks.ReadOutcome.PENDING_ONLY -> Outcome.READ_PENDING_ONLY
        ReadElsewhereMarks.ReadOutcome.UNREAD -> Outcome.READ_UNREAD
    }

    /** The line of a dismissal with no mark, one outcome per [ReadElsewhereMarks.Withdrawal]. */
    fun of(withdrawal: ReadElsewhereMarks.Withdrawal): Outcome = when (withdrawal) {
        ReadElsewhereMarks.Withdrawal.NONE -> Outcome.WITHDRAW_NONE
        ReadElsewhereMarks.Withdrawal.KEPT_PENDING_REPLY -> Outcome.WITHDRAW_KEPT_PENDING_REPLY
        ReadElsewhereMarks.Withdrawal.CANCELLED -> Outcome.WITHDRAW_CANCELLED
        ReadElsewhereMarks.Withdrawal.HELD -> Outcome.WITHDRAW_HELD
    }

    /** The line of a delivered or answered reply, one outcome per [ReadElsewhereMarks.Delivery]. */
    fun of(delivery: ReadElsewhereMarks.Delivery): Outcome = when (delivery) {
        ReadElsewhereMarks.Delivery.NONE -> Outcome.DELIVERY_NONE
        ReadElsewhereMarks.Delivery.CANCELLED -> Outcome.DELIVERY_CANCELLED
        ReadElsewhereMarks.Delivery.REPOSTED -> Outcome.DELIVERY_REPOSTED
        ReadElsewhereMarks.Delivery.NOT_REBUILT -> Outcome.DELIVERY_NOT_REBUILT
        ReadElsewhereMarks.Delivery.KEPT_UNTIL_READ -> Outcome.DELIVERY_KEPT_UNTIL_READ
    }

    /**
     * The outcome of a decision that reached the post, in the order the builder decides its alert:
     * a line already in the shade or a supersede is a redraw ([RepostAlert]), and only a first
     * announcement can be the one a call silences.
     */
    fun posted(alreadyInShade: Boolean, supersedes: Boolean, callHoldsSound: Boolean): Outcome = when {
        alreadyInShade -> Outcome.ALREADY_IN_SHADE
        supersedes -> Outcome.REDRAWN
        callHoldsSound -> Outcome.POSTED_SILENT_CALL
        else -> Outcome.POSTED
    }

    /**
     * Whether a push `dispatchPush`'s foreground guard skips was a VISIBLE message - the only kind
     * that records a line there. A silent frame (a commit, a receipt, a level-`none` conversation,
     * which the server sends silent) and the non-message types announce nothing, so they say nothing.
     */
    fun guardedAnnouncement(type: String?, isReaction: Boolean, silent: Boolean, isWelcome: Boolean): Boolean =
        !silent && !isWelcome && (type == "message" || type == "channel" || isReaction)

    /**
     * The OS settings that decide whether a posted notification is seen, read at the decision.
     * Each field is null when the platform would not answer.
     *
     * @param notificationsEnabled `NotificationManager.areNotificationsEnabled`
     * @param paused               `NotificationManager.areNotificationsPaused` (API 29+: the app suspended)
     * @param channelImportance    the posting channel's `importance` - the CONVERSATION's own channel
     *                             when the member gave it one (API 30+) - null when unknown
     * @param interruptionFilter   `NotificationManager.currentInterruptionFilter` (Do Not Disturb)
     * @param standbyBucket        `UsageStatsManager.appStandbyBucket`
     * @param powerSave            `PowerManager.isPowerSaveMode`
     */
    data class OsState(
        val notificationsEnabled: Boolean?,
        val paused: Boolean?,
        val channelImportance: Int?,
        val interruptionFilter: Int?,
        val standbyBucket: Int?,
        val powerSave: Boolean?,
    ) {
        companion object {
            /** Nothing could be read. */
            val UNREAD = OsState(null, null, null, null, null, null)
        }
    }

    // NotificationManager.IMPORTANCE_NONE.
    private const val IMPORTANCE_NONE = 0

    /**
     * Whether the OS will drop a notification this app posts: the app's switch is off, the app is
     * paused, or the channel (or the conversation's own channel) is blocked. A LOW or MIN channel
     * still shows it, quietly - the member's own choice, which the line reports without accusing.
     */
    fun osDrops(os: OsState): Boolean =
        os.notificationsEnabled == false || os.paused == true || os.channelImportance == IMPORTANCE_NONE

    /** `W` when the app posted what the OS drops, `I` otherwise. */
    fun level(outcome: Outcome, os: OsState): Char = if (outcome.posts && osDrops(os)) 'W' else 'I'

    /** The conversation as the line names it - the one scheme every log line uses, [ConversationRef]. */
    fun conversationRef(conversationId: String?): String = ConversationRef.of(conversationId)

    /**
     * The recorded line. No message text and no name ever reaches it.
     *
     * @param conversationId the conversation (or `channel_<id>` salon), null when the push named none
     * @param channel        the notification channel id it posts on, null before one was chosen
     * @param detail         a short system-worded reason (a withholding level, a push type), or null
     */
    fun line(outcome: Outcome, conversationId: String?, channel: String?, os: OsState, detail: String? = null): String {
        val drop = if (outcome.posts && osDrops(os)) " -> the OS drops it" else ""
        val why = detail?.let { " why: ${it.replace('\n', ' ').take(120)}" } ?: ""
        return "[PUSH_SHOW] outcome=${outcome.token} conv=${conversationRef(conversationId)} channel=${channel ?: "?"}" +
            " os: enabled=${os.notificationsEnabled ?: "?"}" +
            " paused=${os.paused ?: "?"}" +
            " importance=${importanceName(os.channelImportance)}" +
            " dnd=${interruptionFilterName(os.interruptionFilter)}" +
            " bucket=${standbyBucketName(os.standbyBucket)}" +
            " powerSave=${os.powerSave ?: "?"}$drop$why"
    }

    /** `NotificationManager.IMPORTANCE_*` by name; `?` when unread or the channel is missing. */
    fun importanceName(importance: Int?): String = when (importance) {
        null -> "?"
        IMPORTANCE_NONE -> "none"
        1 -> "min"
        2 -> "low"
        3 -> "default"
        4 -> "high"
        5 -> "max"
        -1000 -> "unspecified"
        else -> importance.toString()
    }

    /** `NotificationManager.INTERRUPTION_FILTER_*` by name: `all` is Do Not Disturb off. */
    fun interruptionFilterName(filter: Int?): String = when (filter) {
        null -> "?"
        0 -> "unknown"
        1 -> "all"
        2 -> "priority"
        3 -> "none"
        4 -> "alarms"
        else -> filter.toString()
    }

    /** `UsageStatsManager.STANDBY_BUCKET_*` by name: `rare` and `restricted` defer high-priority FCM. */
    fun standbyBucketName(bucket: Int?): String = when (bucket) {
        null -> "?"
        5 -> "exempted"
        10 -> "active"
        20 -> "working_set"
        30 -> "frequent"
        40 -> "rare"
        45 -> "restricted"
        50 -> "never"
        else -> bucket.toString()
    }
}
