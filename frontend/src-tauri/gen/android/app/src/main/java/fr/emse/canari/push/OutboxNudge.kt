package fr.emse.canari.push

/**
 * WHAT THE "MESSAGES EN ATTENTE" NUDGE DOES, DECIDED FROM THE OUTBOX MIRROR AND NOTHING ELSE.
 *
 * The nudge states a fact about the queue - sends are still owed - so the queue's own durable state
 * decides it: posted only while the mirror holds an entry, withdrawn as soon as it holds none. No
 * timer and no "was it shown" flag: withdrawing is an idempotent cancel, so it needs no memory of
 * a post. Both the post and the withdrawal are decided under the service's `OUTBOX_LOCK`, from a
 * mirror read inside it, so a drain that empties the queue and a caller that asks for the nudge are
 * ordered: whichever runs last reads the last state of the mirror, and the shade follows it.
 * Before 1.7.3 nothing withdrew it, and a delivered reply left it standing until the app opened
 * (Mi 9T, 2026-11-21).
 *
 * Compiled by the JVM test project too, so nothing here may import Android.
 */
object OutboxNudge {
    /** What the shade owes after one look at the mirror. */
    enum class Decision {
        /** Sends are owed and the caller asked: post (or re-post) the nudge. */
        POST,

        /** The mirror holds nothing: the nudge must not stand. An idempotent cancel. */
        WITHDRAW,

        /** Sends are still owed and nobody asked: whatever the shade holds stays as it is. */
        KEEP,

        /**
         * The mirror exists and could not be read: nothing is known about the queue, so nothing is
         * withdrawn - an unreadable file is not an empty queue. Logged as a WARN by the caller.
         */
        UNKNOWN,
    }

    /**
     * The decision for [queued] entries in the mirror (null when the file exists and could not be
     * read). [asked] is true for a caller that has just seen sends remain and wants the nudge up; a
     * drain asks nothing and only withdraws. An unreadable mirror with [asked] still posts: the
     * caller saw sends remain, and a nudge that may be stale is withdrawn by the next drain that
     * reads an empty mirror, where a missing one would hide a reply that was never sent.
     */
    fun decide(queued: Int?, asked: Boolean): Decision = when {
        queued == 0 -> Decision.WITHDRAW
        asked -> Decision.POST
        queued == null -> Decision.UNKNOWN
        else -> Decision.KEEP
    }

    /**
     * Whether the record standing under [id] is a nudge posted BEFORE 1.7.3, when the nudge shared
     * [FixedNotifIds.WORKER_FOREGROUND] with the background worker's foreground notice. The worker's
     * notice is always ongoing (and a foreground-service record when the worker is promoted); the
     * nudge never was either. So [ongoing] and [foregroundService], read from the record itself,
     * tell the two apart, and the worker's live notice is never taken for a leftover nudge.
     */
    fun isPreUpdateNudge(id: Int, ongoing: Boolean, foregroundService: Boolean): Boolean =
        id == FixedNotifIds.WORKER_FOREGROUND && !ongoing && !foregroundService

    /** One record of the shade, as a withdrawal reads it: its id and the two flags that matter. */
    data class Standing(val id: Int, val ongoing: Boolean, val foregroundService: Boolean)

    /** What one read of the shade says stands, for a withdrawal. */
    data class Withdrawal(
        /** A nudge under [FixedNotifIds.OUTBOX_NUDGE] was in the shade. */
        val nudgeStood: Boolean,
        /** A pre-1.7.3 nudge stands under [FixedNotifIds.WORKER_FOREGROUND]: cancel that id too. */
        val preUpdateNudgeStood: Boolean,
        /** The worker's own notice stands under [FixedNotifIds.WORKER_FOREGROUND]: left alone. */
        val workerNoticeStood: Boolean,
    )

    /**
     * Reads [shade] ONCE for a withdrawal, so its line says what actually stood: a drain that
     * empties the mirror runs on every quick reply and every read mark, and "withdrawn" on each of
     * them, with no nudge in the shade, would be false - and is what the device reading takes as
     * evidence. The cancel of [FixedNotifIds.OUTBOX_NUDGE] is issued whatever this says (idempotent,
     * and a post this read lags is still cancelled); only the LINE follows it.
     */
    fun withdrawal(shade: List<Standing>): Withdrawal {
        val old = shade.firstOrNull { it.id == FixedNotifIds.WORKER_FOREGROUND }
        val preUpdate = old != null && isPreUpdateNudge(old.id, old.ongoing, old.foregroundService)
        return Withdrawal(
            nudgeStood = shade.any { it.id == FixedNotifIds.OUTBOX_NUDGE },
            preUpdateNudgeStood = preUpdate,
            workerNoticeStood = old != null && !preUpdate,
        )
    }
}
