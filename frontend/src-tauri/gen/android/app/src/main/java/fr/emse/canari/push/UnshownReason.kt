package fr.emse.canari.push

/**
 * WHY A FRAME THAT DECRYPTED SHOWS NO MESSAGE, as the token `mobile/background.rs` chose names it
 * (2026-11-25) - and whether the generic line a push posted for it stood for nothing.
 *
 * The replay of a held frame ([HeldFrames]) used to remove its generic line for every one of these,
 * as if each were a commit. Only a CONTROL FRAME is: the MLS state advanced and no message exists.
 * The others decrypted a REAL message this device cannot draw - an unknown kind
 * (`plaintext-not-renderable`), a sender MLS did not verify, a peer's seed request only the
 * foreground answers - and the live push keeps the generic line for exactly those: the reader is owed
 * the fact that something arrived, and the app shows it. The replay keeps it too.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard.
 */
enum class UnshownReason(val dropsGenericLine: Boolean) {
    /** `control-frame`: a commit or proposal applied - no message, so its generic line stood for nothing. */
    CONTROL_FRAME(dropsGenericLine = true),

    /** `plaintext-not-renderable`, or `ok` with no text: a message of a kind this path cannot draw. */
    NOT_RENDERABLE(dropsGenericLine = false),

    /** `sender-mismatch`: a message refused for its sender - the app says so, the line stays. */
    SENDER_MISMATCH(dropsGenericLine = false),

    /** `graine-request`: a peer asking for a seed, which only the foreground answers. */
    GRAINE_REQUEST(dropsGenericLine = false),
}
