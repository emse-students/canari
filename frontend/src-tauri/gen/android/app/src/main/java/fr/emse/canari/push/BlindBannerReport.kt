package fr.emse.canari.push

/**
 * WHAT A BLIND SALON BANNER TELLS THE SERVER ABOUT ITSELF, AS A PURE FUNCTION (2026-11-04).
 *
 * A blind banner is the generic "Nouveau message dans #salon" line, drawn by "Quelqu'un" with a "?"
 * disc, where the message should be. It is a FALLBACK, so each one is reported
 * (`POST /api/mls/push/blind-banner`, the server's `[PUSH_BLIND]` line), and the report must carry
 * enough to separate the causes it cannot itself distinguish:
 *
 *  - the open NEVER RAN: one of the four things it needs is missing ([Report.missing]) - no seed in
 *    the mirror, or a ciphertext, nonce or index the server did not inline. [Report.held] says the
 *    frame waits for its seed and may still be redrawn.
 *  - the open RAN and did not show the message ([Report.refused]): a v2 refusal, a floor, an
 *    unreadable mirror, a row that opened with nothing to draw. Until 2026-11-04 these were never
 *    reported at all - the count could not see a whole class of blind banner (a tester's report,
 *    production `1.6.3`).
 *
 * And some answers are not a banner at all ([postsNothing]): a withdrawn reaction, an event silenced
 * by name. Drawing "new message" for those was the defect; they post nothing and are never counted.
 *
 * The tokens are pinned by `libs/contracts/blind-banner-terms.json`, which the server's allowlist,
 * the Rust open and `BlindBannerReportTest` all assert. Compiled by the JVM test project too, so
 * nothing here may import Android (see [PushRecoveryLadder]).
 */
object BlindBannerReport {

    /** Open answers that are deliberately never news: the push posts nothing for them. */
    val SILENT: Set<String> = setOf("reaction-withdrawn", "silent-event")

    /** Opened, and the answer was `ok` with no text to draw. Named here: no native line said it. */
    const val EMPTY_TEXT = "empty-text"

    /** The native open threw. */
    const val EXCEPTION = "exception"

    /** The open refused and named no reason - an older native library, or a refusal nobody named. */
    const val UNSTATED = "unstated"

    /** The three refusal tokens this service names itself, beside those the native open answers. */
    val OWN_REFUSALS: Set<String> = setOf(EMPTY_TEXT, EXCEPTION, UNSTATED)

    /** What one report carries; see the class comment for each field. */
    data class Report(val missing: List<String>, val held: Boolean, val refused: String?)

    /** Whether the open's [reason] means there is nothing to announce, so no banner is posted. */
    fun postsNothing(reason: String?): Boolean = reason in SILENT

    /**
     * The report for a blind banner that reached the shade.
     *
     * THE OPEN RAN ONLY WHEN BOTH HELD: the seed AND the inlined ciphertext, nonce and index
     * (`postChannelNotification`'s guard). A mirrored seed with a ciphertext the server did not
     * inline (the 4 KB FCM budget) never opened, so it reports `missing=ciphertext` - reading
     * [seedHeld] alone as "it ran" turned that into `refused=unstated` and erased the term the
     * `[PUSH_BLIND]` GROUP BY separates the two causes with (review of #3027).
     *
     * @param seedHeld whether the mirror held this session's seed
     * @param openable whether the push carried ciphertext, nonce and index - a frame that is
     *   held for its seed and may be redrawn
     * @param missing  the terms the open lacked (`blindBannerMissing`), read only when it never ran
     * @param refused  why the open that ran did not show the message; [UNSTATED] when it ran and
     *   nobody said why
     */
    fun of(seedHeld: Boolean, openable: Boolean, missing: List<String>, refused: String?): Report =
        if (seedHeld && openable) {
            Report(missing = emptyList(), held = false, refused = refused?.takeIf { it.isNotEmpty() } ?: UNSTATED)
        } else {
            Report(missing = missing, held = openable, refused = null)
        }
}
