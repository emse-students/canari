package fr.emse.canari.push

/**
 * THE NOTIFICATION IDS THAT NEVER CHANGE, AND THE ONE RULE THAT KEEPS A CONVERSATION OFF THEM.
 *
 * A conversation's notification id comes from a persisted counter that starts at 1000 and only
 * grows (`getStableNotifId`), so on a device with enough conversations it walks into these fixed
 * ids - and a conversation posted under 9999 would replace the group summary, under 9995 the
 * wake-up push's notice. [skipReserved] is applied at allocation, so the counter steps over every
 * id here, deterministically; an id already persisted for a conversation is never changed.
 *
 * Every SINGLE fixed id is named here and the services read it from here, so a new one cannot be
 * added without the counter learning to skip it. Two RANGES are not, and the counter does not skip
 * them: the call rings' `CALL_NOTIF_ID_BASE` (700 000) + `callId.hashCode() and 0xFFFF`, which the
 * counter reaches only after ~699 000 conversations on one install; and the per-post ids
 * `notificationIdCounter` hands out from 10 000 per process, which a counter past 10 000 (some
 * 9 000 conversations) can meet - a known overlap, not a guarantee this object gives.
 *
 * Compiled by the JVM test project too, so nothing here may import Android (see [PushRecoveryLadder]).
 */
object FixedNotifIds {
    /** The wake-up push's one "could not be loaded" notice. */
    const val WAKE_UNAVAILABLE = 9995

    /** "A new device was added to your account". */
    const val NEW_DEVICE = 9996

    /** The background MLS worker's failure notice. */
    const val BACKGROUND_FAILURE = 9997

    /**
     * The background MLS worker's foreground notice. Until 1.7.3 the "messages en attente" nudge
     * shared it; no nudge posted then survives the update, which cancels every notification of the
     * package (docs/wiki/frontend/mobile.md, "The outbox nudge"). No code cancels it by id (the
     * app-open sweep of the messages channel that once swept it is gone, 2026-11-21).
     */
    const val WORKER_FOREGROUND = 9998

    /**
     * "Vous avez peut-etre des messages en attente": the outbox nudge, withdrawn when the outbox
     * mirror empties. ITS OWN ID, so withdrawing it can never take the worker's foreground notice
     * down - one id, one meaning. BELOW 1000 ON PURPOSE: the conversation counter starts at 1000 and
     * only grows, so no install has ever persisted this id for a conversation, which an id inside
     * the counter's range could not promise (an id already stored is never moved).
     */
    const val OUTBOX_NUDGE = 999

    /** The message group summary. */
    const val GROUP_SUMMARY = 9999

    /** The ongoing call's foreground service. */
    const val CALL_FOREGROUND = 0x0CA11

    /** The new-mail watch's foreground service (mail lot 4). */
    const val MAIL_WATCH_FOREGROUND = 0x0BA11

    /** Every id above: none may be handed to a conversation. */
    val ALL: Set<Int> = setOf(OUTBOX_NUDGE, WAKE_UNAVAILABLE, NEW_DEVICE, BACKGROUND_FAILURE, WORKER_FOREGROUND, GROUP_SUMMARY, CALL_FOREGROUND, MAIL_WATCH_FOREGROUND)

    /** The first id at or after [candidate] that is not a fixed one. */
    fun skipReserved(candidate: Int): Int {
        var id = candidate
        while (id in ALL) id++
        return id
    }
}
