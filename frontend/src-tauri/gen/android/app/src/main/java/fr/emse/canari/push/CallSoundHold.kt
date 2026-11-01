package fr.emse.canari.push

/**
 * A CALL HOLDS THE PHONE'S SOUND: a notification posted during one is posted SILENT, never dropped
 * (owner, 2026-10-31 - a message banner sounded during an outgoing ring of a production call).
 *
 * What says a call is up is AUTHORITATIVE STATE of this process, never a clock or a flag a page left
 * behind:
 * - the ongoing-call foreground service holds a call (`CallForegroundService.running`): the page
 *   started it once the microphone was held, so from the caller's ring out until the call's end, and
 *   from the callee's answer until its end. It dies with the process, so it cannot go stale;
 * - a native ring is up (`CanariFirebaseMessagingService.activeCallRings`): the CallStyle incoming
 *   ring, from its `call_ring` until it is answered, declined, ended or expired.
 *
 * The message still arrives and is shown - only its sound and vibration go (`setSilent(true)`).
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
object CallSoundHold {

    /**
     * Whether a call holds the sound.
     *
     * @param callInForeground the ongoing-call service is in the foreground with a call.
     * @param nativeRings how many calls ring natively on this phone right now.
     */
    fun held(callInForeground: Boolean, nativeRings: Int): Boolean = callInForeground || nativeRings > 0

    /** How a post alerts once the call is accounted for: SILENT while a call holds the sound. */
    fun alert(mode: RepostAlert.Mode, held: Boolean): RepostAlert.Mode =
        if (held) RepostAlert.Mode.SILENT else mode
}
