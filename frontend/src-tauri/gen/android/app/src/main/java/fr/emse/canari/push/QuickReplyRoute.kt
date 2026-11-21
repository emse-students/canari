package fr.emse.canari.push

/**
 * WHO SENDS A REPLY TYPED IN A NOTIFICATION: the native outbox, or the page.
 *
 * While the foreground guard holds, the native encrypt is refused (`foreground active - background
 * mls.bin write abandoned`), and the retry worker stands down for the page while the app is visible.
 * The page never heard of an entry the native side left in `outbox_pending.ndjson`, so the reply sat
 * queued until the app went to the background (Mi 9T, #3912 reading, 2026-11-20: about four
 * minutes). Asked FIRST, from THE fact the refusal reads - the Rust `foreground_is_active()`, read
 * through `nativeForegroundGuardHolds` - rather than learned from the refusal, and never from a
 * second fact (the activity's resume edge) that could disagree with it: the page then sends it
 * through its own composer path (`pending_quick_replies.ndjson`, `quickReplyDrain.ts`), as on iOS.
 *
 * Guard released, the native drain may write `mls.bin`, and the reply stays native.
 *
 * Compiled by the JVM test project too, so nothing here may import Android - see
 * [PushRecoveryLadder] for why that is the guard and not a style rule.
 */
enum class QuickReplyRoute {
    /** Handed to the page, which sends it through the composer's path. */
    PAGE,

    /** Queued in the outbox mirror and drained natively. */
    NATIVE;

    companion object {
        /** [guardHolds]: the Rust foreground guard holds, so a background `mls.bin` write is refused. */
        fun of(guardHolds: Boolean): QuickReplyRoute = if (guardHolds) PAGE else NATIVE
    }
}
