package fr.emse.canari.push

/**
 * WHICH PUSHES ACT WHILE THE APP IS IN FRONT, as a pure function (2026-11-20).
 *
 * The guard in `CanariFirebaseMessagingService.dispatchPush` exists for ONE reason: two MLS engines
 * must never write `mls.bin` at once, so while the WebView's engine runs, an MLS frame is the
 * socket's. Everything that touches no MLS state and must still happen in front is let through:
 *
 * - `form_reminder` and a `social` push that is not a reaction: they show while the app is open;
 * - `call_ring`: whether it shows in front is `showIncomingCallNotification`'s question;
 * - `channel_read`: a pure cancellation. **It was blocked until 2026-11-20**, on the premise that
 *   "the reading device is in the foreground": but a phone in front showing ANOTHER conversation
 *   holds a native banner for this salon (the WebView posts one through `notifyMessageFromWebSocket`
 *   since 2026-09-18), and a read of that salon on the web, while the phone was in front, was
 *   dropped here - after which nothing ever cleared that banner (owner's report, 2026-11-20).
 *
 * A REACTION RIDES ON `social` and is NOT let through: it is drawn into the conversation's own
 * notification, which a conversation on screen does not want.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
object ForegroundGuard {

    /** Whether a push of [type] is acted on while `MainActivity.isInForeground`. */
    fun actsInForeground(type: String?, isReaction: Boolean): Boolean =
        type == "form_reminder" ||
            (type == "social" && !isReaction) ||
            type == "call_ring" ||
            type == "channel_read"
}
