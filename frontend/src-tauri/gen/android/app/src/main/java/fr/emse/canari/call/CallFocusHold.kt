package fr.emse.canari.call

/**
 * A CALL THAT LOSES THE AUDIO FOCUS IS HELD, NEVER HUNG UP (decided by the lead on 2026-11-12, under
 * the owner's delegation; backlog D056).
 *
 * A cellular call ringing in (`LOSS_TRANSIENT`) or an app taking the focus for good (`LOSS`) used to
 * leave the Canari call's microphone running under it: the member's voice went on to the peer during
 * a phone conversation. Now a loss HOLDS the microphone - the page disables it and tells both the
 * member and the peer, through the same state the system's own microphone hold uses - and the hold is
 * RELEASED, restoring the member's OWN mute state (muted before stays muted), by either of two facts:
 * the platform's GAIN after a transient loss, or a focus ASKED AGAIN and granted ([onAsk]).
 * `LOSS_TRANSIENT_CAN_DUCK` (a navigation prompt that only lowers others' sound) changes nothing.
 *
 * **A PERMANENT `LOSS` IS NEVER FOLLOWED BY A GAIN** (Android's contract: the other app keeps the
 * focus until it abandons it, and nobody is told when it does). So after a `LOSS` - a video started in
 * another app is the common case - the hold would last the rest of the call. The way back is asking:
 * the member's mute or unmute tap while held, and the app coming back on screen, ask for the focus
 * again; a grant releases the hold, a refusal (a phone call still holds the focus) keeps it and says
 * why. Only the member ends a call.
 *
 * Each change is reported once: a second loss while held, or a gain while not held, is no step - so
 * the page is never told twice, and a gain the call took at its start (no loss before it) says nothing.
 *
 * No Android import is allowed in this package (the plain-JVM `android-tests` project compiles it):
 * `AudioManager`'s constants are mapped to [FocusChange] by the caller.
 */
enum class FocusChange { GAIN, LOSS, LOSS_TRANSIENT, LOSS_TRANSIENT_CAN_DUCK, OTHER }

/** What a focus change asks of the call. */
enum class FocusStep {
    /** The focus is gone: hold the microphone and say so to both ends. */
    HOLD,

    /** The focus is back after a hold: give the member's own microphone state back. */
    RELEASE,

    /** The focus was asked again and REFUSED: the hold stays, and the member is told why. */
    STILL_HELD,

    /** Nothing changes for the call. */
    NONE,
}

/** The hold of ONE call, fed every focus change of that call, on one thread (the main looper). */
class CallFocusHold {
    /** Whether the call's microphone is held for a focus loss right now. */
    var held: Boolean = false
        private set

    /** The step [change] asks for, and the new [held]. */
    fun on(change: FocusChange): FocusStep = when (change) {
        FocusChange.LOSS, FocusChange.LOSS_TRANSIENT ->
            if (held) FocusStep.NONE else FocusStep.HOLD.also { held = true }
        FocusChange.GAIN ->
            if (held) FocusStep.RELEASE.also { held = false } else FocusStep.NONE
        FocusChange.LOSS_TRANSIENT_CAN_DUCK, FocusChange.OTHER -> FocusStep.NONE
    }

    /** Whether asking for the focus again could change anything: only a held call asks. */
    val wantsAsk: Boolean get() = held

    /**
     * The step a focus ASKED AGAIN asks for, [granted] being the platform's answer to the request.
     * Only a held call asks ([wantsAsk]); an answer reaching an unheld one changes nothing.
     */
    fun onAsk(granted: Boolean): FocusStep = when {
        !held -> FocusStep.NONE
        granted -> FocusStep.RELEASE.also { held = false }
        else -> FocusStep.STILL_HELD
    }
}
