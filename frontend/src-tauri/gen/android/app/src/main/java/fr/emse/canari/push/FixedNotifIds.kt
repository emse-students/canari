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

    /** "Messages pending sync", and the background worker's foreground notice (one id, shared). */
    const val PENDING_SYNC = 9998

    /** The message group summary. */
    const val GROUP_SUMMARY = 9999

    /** The ongoing call's foreground service. */
    const val CALL_FOREGROUND = 0x0CA11

    /** Every id above: none may be handed to a conversation. */
    val ALL: Set<Int> = setOf(WAKE_UNAVAILABLE, NEW_DEVICE, BACKGROUND_FAILURE, PENDING_SYNC, GROUP_SUMMARY, CALL_FOREGROUND)

    /** The first id at or after [candidate] that is not a fixed one. */
    fun skipReserved(candidate: Int): Int {
        var id = candidate
        while (id in ALL) id++
        return id
    }
}
