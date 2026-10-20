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
 */
data class OngoingCallSpec(
    val title: String,
    val text: String,
    val connectedAtMs: Long?,
    val speaker: Boolean,
) {
    companion object {
        /**
         * Validates what crossed the bridge. A refusal names the field: the web wrote it from its own
         * typed state, so a bad value is a defect on that side, never something to repair here.
         */
        fun of(title: String?, text: String?, connectedAtMs: Long?, speaker: Boolean?): SpecResult {
            if (title.isNullOrBlank()) return SpecResult.Refused("title is empty")
            if (text == null) return SpecResult.Refused("text is missing")
            if (connectedAtMs != null && connectedAtMs <= 0L) {
                return SpecResult.Refused("connectedAtMs=$connectedAtMs is not an instant")
            }
            if (speaker == null) return SpecResult.Refused("speaker is missing")
            return SpecResult.Valid(OngoingCallSpec(title, text, connectedAtMs, speaker))
        }
    }
}

/** The outcome of [OngoingCallSpec.of]. */
sealed class SpecResult {
    data class Valid(val spec: OngoingCallSpec) : SpecResult()
    data class Refused(val reason: String) : SpecResult()
}

/** What reaches the service: from the web (start, update, stop) or from its own notification. */
sealed class CallServiceCommand {
    data class Start(val spec: OngoingCallSpec) : CallServiceCommand()
    data class Update(val spec: OngoingCallSpec) : CallServiceCommand()
    data class Stop(val reason: String) : CallServiceCommand()
    /** The hang-up action of the ongoing notification. */
    object HangUp : CallServiceCommand()
}

/** What the service does. Exactly one per command, so every command is logged with its effect. */
sealed class CallServiceEffect {
    /** Enter the foreground with this call: notification, audio mode, route, wake lock. */
    data class EnterForeground(val spec: OngoingCallSpec) : CallServiceEffect()
    /** Already in the foreground: redraw the notification, re-apply the route if it changed. */
    data class Refresh(val spec: OngoingCallSpec) : CallServiceEffect()
    /** Leave the foreground and stop: the call is over (or its page is gone). */
    data class Leave(val reason: String) : CallServiceEffect()
    /** Hand the hang-up to the web, which owns the call and will send `stop` once it has ended it. */
    object ForwardHangUp : CallServiceEffect()
    /** Nothing to do, and the reason says why - logged, because "nothing" must be explained. */
    data class Ignore(val reason: String) : CallServiceEffect()
}

/**
 * The service's whole transition table.
 *
 * - A START while running is the same call described again (the web's effect re-ran): a refresh,
 *   never a second foreground entry.
 * - An UPDATE before any START is refused: the web sends a start first by construction, so an update
 *   alone means its state and the service's disagree, and drawing a notification from it would
 *   claim a foreground the service never took.
 * - A STOP or a HANG-UP with no call has nothing to act on.
 */
fun decide(running: Boolean, command: CallServiceCommand): CallServiceEffect = when (command) {
    is CallServiceCommand.Start ->
        if (running) CallServiceEffect.Refresh(command.spec) else CallServiceEffect.EnterForeground(command.spec)
    is CallServiceCommand.Update ->
        if (running) CallServiceEffect.Refresh(command.spec)
        else CallServiceEffect.Ignore("update before any start - the web and the service disagree")
    is CallServiceCommand.Stop ->
        if (running) CallServiceEffect.Leave(command.reason)
        else CallServiceEffect.Ignore("stop (${command.reason}) with no call in the foreground")
    CallServiceCommand.HangUp ->
        if (running) CallServiceEffect.ForwardHangUp
        else CallServiceEffect.Ignore("hang-up pressed with no call in the foreground")
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

private val PERSONAL_OUTPUTS = listOf(
    CallOutput.HEARING_AID,
    CallOutput.BLE_HEADSET,
    CallOutput.BLUETOOTH_SCO,
    CallOutput.WIRED_HEADSET,
    CallOutput.USB_HEADSET,
    CallOutput.EARPIECE,
)
