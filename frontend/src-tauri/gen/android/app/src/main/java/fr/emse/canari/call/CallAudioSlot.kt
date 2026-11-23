package fr.emse.canari.call

/**
 * One call's audio as [CallAudioSlot] sees it: labelled with the call it serves, closed once.
 *
 * The label is load-bearing: every `focus` event the audio emits carries [callId], and the page drops
 * an event for any call but its own. So the label must always be the call in the foreground.
 */
interface CallAudioLease {
    /** The call this audio reports its focus events for. */
    val callId: String

    /**
     * Relabels this audio to [newCallId] and re-sends its current state (the focus hold, the output)
     * under it. The mode, the output and the focus request are KEPT: the call goes on.
     */
    fun handOver(newCallId: String)

    /** Abandons the focus request, clears the output, gives back the mode it set; [why] is logged. */
    fun close(why: String)
}

/**
 * THE ONE PLACE A CALL'S AUDIO IS OPENED, HANDED OVER AND CLOSED (review of #4012, 2026-11-23).
 *
 * The ongoing-call service used to open its audio only when entering the foreground, and a start of
 * ANOTHER call while one held the foreground (`CallServiceEffect.Replace`) kept the audio labelled
 * with the EARLIER call: its focus events (a loss, the delayed GAIN, the hold at the start) went out
 * under the old call id and the new call's page dropped them - a cellular call ending during the
 * replacing call never gave its microphone back.
 *
 * A replacement is a HANDOVER ([handOver]), never a close and a reopen: the voice is live, and closing
 * would dip the mode (`MODE_NORMAL`, then `MODE_IN_COMMUNICATION` again), clear the communication
 * device (a Bluetooth SCO link drops for a second or two) and abandon the focus (paused music blips
 * back). The audio keeps all three and only its label, and the state the page is told, move to the
 * new call. [close] is reached once, when the call leaves the foreground.
 *
 * Every `why` and `event` handed to this file MUST be a string literal (or built from literals): the
 * log lines it builds go through a sink the native log-content gate (`nativeLogContent.test.ts`)
 * cannot see into.
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
     * Opens the audio of [callId] with [make]. The service opens once per foreground entry, so an
     * audio still held here is a defect: it is accused and closed first, never leaked.
     */
    fun open(callId: String, make: (callId: String) -> A): A {
        val previous = current
        if (previous == null) {
            log(false, "audio opens for call=${short(callId)}")
        } else {
            log(true, "audio opens for call=${short(callId)} while call=${short(previous.callId)}'s is held - that one closes first")
            current = null
            previous.close("an open found it still held")
        }
        return make(callId).also { current = it }
    }

    /**
     * Hands the held audio over to [callId] (a call replacing another in the service). Returns the
     * audio, or null when none is held - a defect, accused: the replacement has no audio to keep.
     */
    fun handOver(callId: String): A? {
        val held = current
        if (held == null) {
            log(true, "no audio to hand over to call=${short(callId)} - the replacing call has no call audio")
            return null
        }
        if (held.callId == callId) {
            log(true, "audio of call=${short(callId)} handed over to itself - nothing to relabel")
            return held
        }
        log(false, "audio hands over from call=${short(held.callId)} to call=${short(callId)} - mode, output and focus kept")
        held.handOver(callId)
        return held
    }

    /** Closes the audio the slot holds, exactly once; [why] (a literal) says what ended it. */
    fun close(why: String) {
        val previous = current
        if (previous == null) {
            log(true, "no audio to close ($why) - it was never opened, or already closed")
            return
        }
        current = null
        log(false, "audio of call=${short(previous.callId)} closes ($why)")
        previous.close(why)
    }
}

/**
 * WHETHER A CALL'S AUDIO MAY STILL ACT. A device callback or a focus change already posted to the
 * main looper can run AFTER the audio closed; acting then would re-route a released output or tell
 * a page about a call that is gone. Each such late event is refused with ONE accusing line.
 */
class CallAudioLife(
    /** One log line; [accuse] is true for a state the design does not expect. */
    private val log: (accuse: Boolean, message: String) -> Unit,
) {
    var closed = false
        private set

    /** Marks the audio closed; false (accused) when it already was - a second close does nothing. */
    fun close(callId: String): Boolean {
        if (closed) {
            log(true, "audio of call=${short(callId)} closed twice - the second close does nothing")
            return false
        }
        closed = true
        return true
    }

    /** Whether [event] (a literal) may act; false, with one accusing line, once the audio closed. */
    fun admits(event: String, callId: String): Boolean {
        if (!closed) return true
        log(true, "$event for call=${short(callId)} after its audio closed - ignored") // log-safe: every caller (CallAudio) passes a literal event name; the id is cut to 8 characters
        return false
    }
}

private fun short(callId: String): String = callId.take(8)
