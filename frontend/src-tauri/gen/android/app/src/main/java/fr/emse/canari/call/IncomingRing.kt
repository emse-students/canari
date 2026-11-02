package fr.emse.canari.call

/**
 * THE INCOMING RING'S FACTS, SHARED BY THE CHANNEL AND THE IN-APP PLAYER (owner, 2026-11-01: Canari
 * rings with its OWN tone, "C1" - two canaries, `RING_PHRASE` in `soundPalette.ts`, rendered by
 * `tools/notification-sounds/render.mjs` into `res/raw/canari_ring.wav`).
 *
 * No Android import is allowed here (the plain-JVM `android-tests` project compiles this package;
 * see [OngoingCallSpec]): the channel id, the ids it replaces and the ringer-mode rule are tested
 * there, and `CanariApplication` / [fr.emse.canari.CallRingPlayer] apply them.
 */
object IncomingRing {
    /**
     * The incoming-call channel. `_v2` since the Canari ring: a channel's SOUND IS IMMUTABLE once
     * created, so the tone could only reach phones that already had `canari_calls` (with the system
     * default ringtone) on a new id. The user can still pick another sound in its settings.
     */
    const val CHANNEL_ID = "canari_calls_v2"

    /** The ids the channel replaced, deleted at startup so they do not linger as a dead entry. */
    val SUPERSEDED_CHANNEL_IDS: List<String> = listOf("canari_calls")

    /**
     * The ring's vibration: on 800 ms, off 400 ms, three times - the channel's pattern, and the
     * in-app player's, which REPEATS it from [VIBRATION_REPEAT_FROM] until the ring stops.
     */
    val VIBRATION_PATTERN: LongArray = longArrayOf(0, 800, 400, 800, 400, 800, 1200)

    /** The index the in-app player's vibration repeats from: the whole pattern, again and again. */
    const val VIBRATION_REPEAT_FROM = 0

    /** `AudioManager.RINGER_MODE_*`, spelled here so the rule is testable without Android. */
    const val RINGER_MODE_SILENT = 0
    const val RINGER_MODE_VIBRATE = 1
    const val RINGER_MODE_NORMAL = 2

    /** What the in-app ring does: play the tone, vibrate, both or neither. */
    data class Plan(val sound: Boolean, val vibrate: Boolean)

    /**
     * What the in-app ring does under the phone's state, as the system's own ring would: SILENT
     * neither sounds nor vibrates, VIBRATE only vibrates, NORMAL does both - and [inAnotherCall] (the
     * audio mode is not `MODE_NORMAL`: a phone or VoIP call is up) only vibrates, as a call waiting
     * does, so the tone never plays into the other call. [appSounds] is the app's own "sounds"
     * setting: off, the tone is not played, the vibration still says a call is there. An unknown
     * ringer mode (a newer platform) rings normally - a call must never be missed for a value this
     * code has not met, and the decision is logged with the raw value.
     */
    fun plan(ringerMode: Int, appSounds: Boolean, inAnotherCall: Boolean): Plan = when (ringerMode) {
        RINGER_MODE_SILENT -> Plan(sound = false, vibrate = false)
        RINGER_MODE_VIBRATE -> Plan(sound = false, vibrate = true)
        else -> Plan(sound = appSounds && !inAnotherCall, vibrate = true)
    }

    /** `NotificationManager.IMPORTANCE_*`, spelled here for the same reason. */
    const val IMPORTANCE_UNSPECIFIED = -1000
    const val IMPORTANCE_HIGH = 4

    /**
     * The importance `canari_calls_v2` is created with: the one the user left on `canari_calls`, so
     * the new id does not undo their choice - a channel they turned off (`NONE`) stays off. A phone
     * with no old channel (a fresh install) gets [IMPORTANCE_HIGH].
     */
    fun inheritedImportance(oldImportance: Int?): Int =
        if (oldImportance == null || oldImportance == IMPORTANCE_UNSPECIFIED) IMPORTANCE_HIGH else oldImportance

    /** What to do about the "grant Do Not Disturb again" ask, decided by [dndAsk]. */
    enum class DndAsk {
        /** Nothing is owed, or it was already asked in this launch. */
        NONE,

        /** Ask the user (once in this launch). */
        ASK,

        /** The user already granted the new channel by hand: the debt is paid, forget it. */
        CLEAR,
    }

    /**
     * Whether the page asks the user to grant `canari_calls_v2` "override Do Not Disturb" again.
     * [owed]: the old channel had it and the user has not answered the ask yet. [granted]: the new
     * channel already has it - the user set it by hand, so asking would be noise. [askedThisLaunch]:
     * the ask was shown in this process - an unanswered one comes back at the next LAUNCH, never on
     * every page load.
     */
    fun dndAsk(owed: Boolean, granted: Boolean, askedThisLaunch: Boolean): DndAsk = when {
        !owed -> DndAsk.NONE
        granted -> DndAsk.CLEAR
        askedThisLaunch -> DndAsk.NONE
        else -> DndAsk.ASK
    }
}
