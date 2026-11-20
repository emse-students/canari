package fr.emse.canari.push

/**
 * WHAT ONE SHOW DECISION DID, AND WHAT THE OS WAS SET TO WHEN IT DID IT (2026-11-20).
 *
 * `showMessageNotification` can take a message and draw nothing - the app is in the foreground, the
 * reader already read it from the shade, it was already announced and dismissed - and it can post a
 * notification the OS then drops or silences, since `NotificationManager.notify` checks neither the
 * app's switch nor the channel's importance. Each of those was a logcat `Log.d` only, so a member's
 * exported log could not tell "suppressed by design" from "posted" from "posted and dropped by the
 * OS": a full-mode push was cached on 2026-11-20 and no notification was seen, and nothing said why.
 *
 * So every return of the show decision records ONE line ([line]) into the in-app log, through the
 * push service's recorded-info path (`FcmLog.iRecorded`), and that line is a WARN ([level]) exactly
 * when the app meant to show something the OS will not - the one outcome that is a defect to chase
 * rather than a decision to read.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard. The OS constants are therefore restated below by
 * value; each is a frozen platform constant (`NotificationManager`, `UsageStatsManager`).
 */
object PushShowOutcome {

    /** Each way the show decision ends. [posts] is whether it reached `manager.notify`. */
    enum class Outcome(val token: String, val posts: Boolean) {
        /** A first announcement, alerting as its channel says. */
        POSTED("posted", true),
        /** A first announcement posted without its sound, because a call holds it ([CallSoundHold]). */
        POSTED_SILENT_CALL("posted-silent-call", true),
        /** The other trigger already put this message in the shade: refreshed, no second alert. */
        ALREADY_IN_SHADE("already-in-shade", true),
        /** The post replaces a line already announced (a blind banner's decrypted redraw): no alert. */
        REDRAWN("redrawn", true),
        /** A push, with the app in the foreground: the WebSocket already delivered it to the UI. */
        SUPPRESSED_FOREGROUND("suppressed-foreground", false),
        /** The reader already read the conversation up to this message from the shade. */
        SUPPRESSED_SHADE_MARK("suppressed-shade-mark", false),
        /** Already announced, then dismissed (swiped, or cleared by a launch): not announced twice. */
        SUPPRESSED_ALREADY_ALERTED("suppressed-already-alerted", false),
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
     * The OS settings that decide whether a posted notification is seen, read at the decision.
     * Each field is null when the platform would not answer.
     *
     * @param notificationsEnabled `NotificationManager.areNotificationsEnabled`
     * @param channelImportance    the posting channel's `importance`; null also when the channel does not exist
     * @param interruptionFilter   `NotificationManager.currentInterruptionFilter` (Do Not Disturb)
     * @param standbyBucket        `UsageStatsManager.appStandbyBucket`
     * @param powerSave            `PowerManager.isPowerSaveMode`
     */
    data class OsState(
        val notificationsEnabled: Boolean?,
        val channelImportance: Int?,
        val interruptionFilter: Int?,
        val standbyBucket: Int?,
        val powerSave: Boolean?,
    )

    // NotificationManager.IMPORTANCE_*.
    private const val IMPORTANCE_NONE = 0

    /**
     * Whether the OS will drop a notification this app posts: the app's switch is off, or the
     * channel is blocked. A LOW or MIN channel still shows it, quietly - the member's own choice,
     * which the line reports without accusing.
     */
    fun osDrops(os: OsState): Boolean =
        os.notificationsEnabled == false || os.channelImportance == IMPORTANCE_NONE

    /** `W` when the app meant to show what the OS drops, `I` otherwise. */
    fun level(outcome: Outcome, os: OsState): Char = if (outcome.posts && osDrops(os)) 'W' else 'I'

    /**
     * The recorded line. Ids are cut to 8 characters, the in-app log's pattern; no message text and
     * no name ever reaches it.
     *
     * @param conversationId the conversation (or `channel_<id>` salon) the decision was about
     * @param channel        the notification channel id it posts on
     */
    fun line(outcome: Outcome, conversationId: String, channel: String, os: OsState): String {
        val drop = if (outcome.posts && osDrops(os)) " -> the OS drops it" else ""
        return "[PUSH_SHOW] outcome=${outcome.token} groupId=${conversationId.take(8)} channel=$channel" +
            " os: enabled=${os.notificationsEnabled ?: "?"}" +
            " importance=${importanceName(os.channelImportance)}" +
            " dnd=${interruptionFilterName(os.interruptionFilter)}" +
            " bucket=${standbyBucketName(os.standbyBucket)}" +
            " powerSave=${os.powerSave ?: "?"}$drop"
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
