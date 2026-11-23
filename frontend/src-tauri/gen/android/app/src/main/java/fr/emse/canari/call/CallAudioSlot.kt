package fr.emse.canari.call

/**
 * One call's audio as [CallAudioSlot] sees it: labelled with the call it serves, closed once.
 *
 * The label is load-bearing: every `focus` event the audio emits carries [callId], and the page drops
 * an event for any call but its own. So an audio must never outlive the call it was opened for.
 */
interface CallAudioLease {
    /** The call this audio reports its focus events for. */
    val callId: String

    /** Abandons the focus request, clears the output, gives back the mode it set; [why] is logged. */
    fun close(why: String)
}

/**
 * THE ONE PLACE A CALL'S AUDIO IS OPENED AND CLOSED (review of #4012, 2026-11-23).
 *
 * The ongoing-call service used to open its audio only when entering the foreground, so a start of
 * ANOTHER call while one held the foreground (`CallServiceEffect.Replace`) kept the earlier call's
 * audio: its focus events (a loss, the delayed GAIN, the hold at the start) went out under the OLD
 * call id and the new call's page dropped them - a cellular call ending during the replacing call
 * never gave its microphone back. Now the first open and a replacement both go through [open], which
 * closes whatever audio the slot holds BEFORE making the new one (so the old focus request is
 * abandoned before the new one is asked, and never answers in the new call's place).
 *
 * No Android import is allowed in this package (the plain-JVM `android-tests` project compiles it);
 * the service hands the factory and the log. Main looper only, like the service.
 */
class CallAudioSlot<A : CallAudioLease>(
    /** One log line; [accuse] is true for a state the design does not expect. */
    private val log: (accuse: Boolean, message: String) -> Unit,
) {
    /** The audio of the call in the foreground; null before the first open and after [close]. */
    var current: A? = null
        private set

    /**
     * Opens the audio of [callId] with [make], first closing the audio the slot holds - whichever
     * call it belongs to. Returns the new audio, which the slot now holds.
     */
    fun open(callId: String, make: (callId: String) -> A): A {
        val previous = current
        if (previous == null) {
            log(false, "audio opens for call=${short(callId)}")
        } else {
            log(
                previous.callId == callId,
                "audio of call=${short(previous.callId)} closed before call=${short(callId)} opens its own - " +
                    "its focus events would carry the wrong call",
            )
            current = null
            previous.close("replaced by call=${short(callId)}")
        }
        return make(callId).also { current = it }
    }

    /** Closes the audio the slot holds, if any; [why] says what ended it. */
    fun close(why: String) {
        val previous = current
        if (previous == null) {
            log(false, "no audio to close ($why)")
            return
        }
        current = null
        log(false, "audio of call=${short(previous.callId)} closes ($why)")
        previous.close(why)
    }

    private fun short(callId: String): String = callId.take(8)
}
