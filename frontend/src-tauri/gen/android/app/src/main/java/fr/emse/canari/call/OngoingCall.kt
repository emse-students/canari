package fr.emse.canari.call

/**
 * THE PURE HALF OF THE ONGOING-CALL SERVICE (WP-C-BG-A): what the web asked for, what the service
 * does about it, and which output carries the voice. No Android import is allowed in this package:
 * the plain-JVM `android-tests` project compiles it from this tree, and an Android import breaks that
 * build - which is the guard (`fr.emse.canari.push` and `.gesture` follow the same rule).
 *
 * The web layer owns the call; Android owns what keeps it alive when the app leaves the screen. The
 * web hands over ONE description of the call ([OngoingCallSpec]) on every change, and the service
 * answers the commands of [CallServiceCommand] through [decide], whose answer is the whole of what
 * the Android half is allowed to do.
 */

/**
 * The call as the notification and the audio route need it, written by the web from its own state.
 *
 * @property title the other party's display name (already resolved by the web, Paraglide's neutral
 *   "Appel" when it has none) - the CallStyle person.
 * @property text the status line under it, a Paraglide string ("Connexion...", "Reconnexion...").
 * @property connectedAtMs the epoch ms of the first `connected` (`CallService.connectedAt`), the
 *   chronometer's base; null while the call has not connected, and then no chronometer is drawn.
 * @property speaker true routes the voice to the loudspeaker, false to the earpiece or a headset.
 * @property peerUserId the other party's user id, whose photo becomes the CallStyle person's icon;
 *   null when the page names no single other party (the icon is then the platform's default).
 * @property muted the user's own microphone mute, drawn as the notification's mute / unmute action.
 */
data class OngoingCallSpec(
    val title: String,
    val text: String,
    val connectedAtMs: Long?,
    val speaker: Boolean,
    val peerUserId: String? = null,
    val muted: Boolean = false,
) {
    companion object {
        /**
         * Validates what crossed the bridge. A refusal names the field: the web wrote it from its own
         * typed state, so a bad value is a defect on that side, never something to repair here.
         */
        fun of(
            title: String?,
            text: String?,
            connectedAtMs: Long?,
            speaker: Boolean?,
            peerUserId: String?,
            muted: Boolean?,
        ): SpecResult {
            if (title.isNullOrBlank()) return SpecResult.Refused("title is empty")
            if (text == null) return SpecResult.Refused("text is missing")
            if (connectedAtMs != null && connectedAtMs <= 0L) {
                return SpecResult.Refused("connectedAtMs=$connectedAtMs is not an instant")
            }
            if (speaker == null) return SpecResult.Refused("speaker is missing")
            if (muted == null) return SpecResult.Refused("muted is missing")
            // A blank id names nobody: the same as none, never a fetch of an empty path.
            val peer = peerUserId?.takeIf { it.isNotBlank() }
            return SpecResult.Valid(OngoingCallSpec(title, text, connectedAtMs, speaker, peer, muted))
        }
    }
}

/** The outcome of [OngoingCallSpec.of]. */
sealed class SpecResult {
    data class Valid(val spec: OngoingCallSpec) : SpecResult()
    data class Refused(val reason: String) : SpecResult()
}

/**
 * What reaches the service: from the web (start, update, stop) or from its own notification.
 *
 * Every command of the web names its CALL: an id the page draws once per call
 * (`androidCallService.ts`), carried by `start` and `update` and echoed by every event the service
 * sends back, so a command or an event of an EARLIER call that lands late is told apart from the
 * current one by a fact, never by timing. A [Stop] with a null [Stop.callId] stops whatever runs: it
 * comes from the app itself (the page that held the call is gone, a new page loaded), not from a call.
 */
sealed class CallServiceCommand {
    data class Start(val callId: String, val spec: OngoingCallSpec) : CallServiceCommand()
    data class Update(val callId: String, val spec: OngoingCallSpec) : CallServiceCommand()
    data class Stop(val callId: String?, val reason: String) : CallServiceCommand()
    /** The hang-up action of the ongoing notification. */
    object HangUp : CallServiceCommand()
    /** The mute / unmute action of the ongoing notification. */
    object ToggleMute : CallServiceCommand()
}

/** What the service does. Exactly one per command, so every command is logged with its effect. */
sealed class CallServiceEffect {
    /** Enter the foreground with this call: notification, audio mode, route, wake lock. */
    data class EnterForeground(val callId: String, val spec: OngoingCallSpec) : CallServiceEffect()
    /** Already in the foreground with this call: redraw the notification, re-apply a changed route. */
    data class Refresh(val callId: String, val spec: OngoingCallSpec) : CallServiceEffect()
    /**
     * A start for a NEW call while [previous] still holds the foreground: the previous call's stop
     * never reached the service, which is a defect on the way there and is logged as one. The new call
     * takes the foreground over (its notification, its route): leaving it unprotected would cost the
     * user the call for a message the app lost.
     */
    data class Replace(val callId: String, val spec: OngoingCallSpec, val previous: String) : CallServiceEffect()
    /** Leave the foreground and stop: the call is over (or its page is gone). */
    data class Leave(val reason: String) : CallServiceEffect()
    /** Leave the foreground, then hand the hang-up of [callId] to the page, which ends the call. */
    data class ForwardHangUp(val callId: String) : CallServiceEffect()
    /**
     * Hand the mute toggle of [callId] to the page, which owns the microphone. The service stays in
     * the foreground; the page's next `update` carries the new `muted`, which redraws the action - so
     * the notification shows the state the CALL is in, never the one a press assumed.
     */
    data class ForwardMute(val callId: String) : CallServiceEffect()
    /**
     * Nothing to do, and the reason says why. Every case reaching it is EXPECTED - a page command in
     * flight when the service had already left (the user hung up from the notification, the start was
     * refused, the page has not received that event yet) - so it is logged at INFO with that cause.
     */
    data class Ignore(val reason: String) : CallServiceEffect()
}

/**
 * The service's whole transition table, [current] being the id of the call in the foreground (null
 * when none is).
 *
 * - A START of the running call is the same call described again (the web's effect re-ran): a
 *   refresh, never a second foreground entry. A start of ANOTHER call is a [CallServiceEffect.Replace].
 * - An UPDATE of a call that is not the running one acts on nothing: either no call runs (the start
 *   was refused, or the user hung up from the notification, and the page had not heard yet) or it is
 *   an earlier call's, landing late.
 * - A STOP of the running call, or one naming no call (from the app itself), leaves; any other stop is
 *   an earlier call's.
 * - A HANG-UP or a MUTE with no call has nothing to act on: a notification press that raced the
 *   call's end.
 */
fun decide(current: String?, command: CallServiceCommand): CallServiceEffect = when (command) {
    is CallServiceCommand.Start -> when (current) {
        null -> CallServiceEffect.EnterForeground(command.callId, command.spec)
        command.callId -> CallServiceEffect.Refresh(command.callId, command.spec)
        else -> CallServiceEffect.Replace(command.callId, command.spec, current)
    }
    is CallServiceCommand.Update -> when (current) {
        command.callId -> CallServiceEffect.Refresh(command.callId, command.spec)
        null -> CallServiceEffect.Ignore(
            "update with no call in the foreground - sent before the page heard the service had left or was refused",
        )
        else -> CallServiceEffect.Ignore("update of an earlier call, landing late")
    }
    is CallServiceCommand.Stop -> when {
        current == null -> CallServiceEffect.Ignore(
            "stop (${command.reason}) with no call in the foreground - the service had already left or was refused",
        )
        command.callId == null || command.callId == current -> CallServiceEffect.Leave(command.reason)
        else -> CallServiceEffect.Ignore("stop (${command.reason}) of an earlier call, landing late")
    }
    CallServiceCommand.HangUp ->
        if (current != null) CallServiceEffect.ForwardHangUp(current)
        else CallServiceEffect.Ignore("hang-up pressed as the call ended - nothing in the foreground")
    CallServiceCommand.ToggleMute ->
        if (current != null) CallServiceEffect.ForwardMute(current)
        else CallServiceEffect.Ignore("mute pressed as the call ended - nothing in the foreground")
}

/** Why a start was refused, as the page reads it (`NativeCallRefusal` in `androidCallService.ts`). */
enum class StartRefusal(val code: String) {
    /** The app was not on screen: the next resume answers it (a `foreground` event). */
    OFF_SCREEN("off-screen"),
    /** Anything else: final for the call. */
    REFUSED("refused"),
}

/**
 * Classifies a `startForeground` that threw. Android refuses a while-in-use (`microphone`) type to an
 * app that is not on screen with a `SecurityException` or, API 31+, a
 * `ForegroundServiceStartNotAllowedException`; [offScreenKind] says the exception is one of those two.
 * The bridge checked "on screen" on its own thread before asking, and the user can press HOME between
 * that check and this call on the main thread - so one of those exceptions met while the app is NOT
 * on screen is [StartRefusal.OFF_SCREEN], answered by the next resume. The same exception with the app
 * on screen, or any other, is a refusal nobody has named: final.
 */
fun classifyStartRefusal(offScreenKind: Boolean, appOnScreen: Boolean): StartRefusal =
    if (offScreenKind && !appOnScreen) StartRefusal.OFF_SCREEN else StartRefusal.REFUSED

/**
 * THE ONE PLACE A START REFUSED FOR BEING OFF SCREEN IS REMEMBERED, AND ANSWERED BY THE NEXT RESUME.
 *
 * Two threads meet here: the bridge's binder thread checks "on screen" and records a refusal; the main
 * thread marks the activity resumed and asks for what is pending. Unlocked, the bridge could read
 * "not on screen", the activity resume and find nothing pending, and the bridge then record a refusal
 * no resume would ever answer. Under one lock, with the caller's precondition that the "on screen"
 * flag is written BEFORE [resumed] is called, every interleaving ends in exactly one of: the start
 * goes ahead, or the refusal is reported and then answered - in that order, because the reports are
 * made inside the lock.
 */
class OffScreenGate {
    private val lock = Any()
    private var pending: String? = null

    /**
     * The bridge's check. Returns true when the start may go ahead (and forgets an older pending
     * refusal: a newer start supersedes it); otherwise records [callId] and calls [onRefused] inside
     * the lock, so its report precedes the resume's.
     */
    fun admit(callId: String, onScreen: () -> Boolean, onRefused: () -> Unit): Boolean = synchronized(lock) {
        if (onScreen()) {
            pending = null
            true
        } else {
            pending = callId
            onRefused()
            false
        }
    }

    /** A refusal found later, by the service itself ([classifyStartRefusal]): recorded the same way. */
    fun refusedOffScreen(callId: String, onRefused: () -> Unit) = synchronized(lock) {
        pending = callId
        onRefused()
    }

    /**
     * The activity resumed (its "on screen" flag already written). Calls [onResumed] with the call
     * whose start was refused, once, inside the lock; nothing when nothing is pending.
     */
    fun resumed(onResumed: (String) -> Unit) = synchronized(lock) {
        val callId = pending ?: return
        pending = null
        onResumed(callId)
    }
}

/**
 * An output a call can use, as `AudioDeviceInfo.getType()` classifies it - mapped on the Android side,
 * kept as our own enum here so the choice is testable without an Android classpath.
 */
enum class CallOutput { SPEAKER, EARPIECE, WIRED_HEADSET, USB_HEADSET, BLUETOOTH_SCO, BLE_HEADSET, HEARING_AID, OTHER }

/**
 * Which output carries the voice, from what the system offers (`availableCommunicationDevices`).
 *
 * - [speaker] true: the loudspeaker, if the device has one.
 * - [speaker] false: the most PERSONAL output present - a hearing aid, then a Bluetooth headset (LE
 *   then classic SCO), then a wired or USB headset, then the earpiece. Someone who put a headset on
 *   during a call means it, which is why a device change re-runs this choice
 *   (`CallForegroundService` listens for it).
 *
 * Null when nothing fits (a tablet with no earpiece asked for the earpiece): the service then
 * clears its choice and the platform's own routing decides, and it says so in the log.
 */
fun pickCallOutput(available: List<CallOutput>, speaker: Boolean): CallOutput? {
    if (speaker) return CallOutput.SPEAKER.takeIf { it in available }
    return PERSONAL_OUTPUTS.firstOrNull { it in available }
}

/**
 * Whether the screen goes dark against the cheek: true only while the voice is on the EARPIECE, the
 * one output held to the face. On the loudspeaker or a headset the phone is looked at or pocketed, and
 * a screen that turned off when a hand passed over the sensor would hide the call's own controls. Null
 * (the platform routes) holds nothing: what it chose is not known here.
 */
fun holdsProximityScreenOff(output: CallOutput?): Boolean = output == CallOutput.EARPIECE

private val PERSONAL_OUTPUTS = listOf(
    CallOutput.HEARING_AID,
    CallOutput.BLE_HEADSET,
    CallOutput.BLUETOOTH_SCO,
    CallOutput.WIRED_HEADSET,
    CallOutput.USB_HEADSET,
    CallOutput.EARPIECE,
)
