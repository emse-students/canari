package fr.emse.canari.push

/**
 * WHO SENDS A REPLY TYPED IN A NOTIFICATION: the native outbox, or the page.
 *
 * With the app in front and the page holding a loaded MLS manager, the native encrypt is refused by
 * the foreground guard (`foreground active - background mls.bin write abandoned`), and the retry
 * worker stands down for the page while the app is visible. The page never heard of an entry the
 * native side left in `outbox_pending.ndjson`, so the reply sat queued until the app went to the
 * background (Mi 9T, #3912 reading, 2026-11-20: about four minutes). Asked FIRST, from the two facts
 * that decide it, rather than learned from the refusal: the page then sends it through its own
 * composer path (`pending_quick_replies.ndjson`, `quickReplyDrain.ts`), as on iOS.
 *
 * Anything else stays native: in the background the native drain may write `mls.bin`, and at the
 * PIN gate no manager is loaded for the guard to protect. [pageHoldsMls] is asked only when the app
 * is in front - it is a native call.
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
        /** [appInFront]: the activity is resumed; [pageHoldsMls]: a manager is loaded in this process. */
        fun of(appInFront: Boolean, pageHoldsMls: () -> Boolean): QuickReplyRoute =
            if (appInFront && pageHoldsMls()) PAGE else NATIVE
    }
}
