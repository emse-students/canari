## Reading owed - the pre-live screen says a suspension before Start

target: 1.7.0

Built 2026-11-15: the pre-live sheet reads `GET /api/lives/standing` with the limits and the rules,
says a running suspension (with its end date) or a withdrawal, and disables Start
([live](../frontend/modules/live.md#the-broadcaster-as-built)). Proven by unit and component tests
only; no device has shown it.

**The reading, on the first pre-release that carries it, on dev, one phone is enough (the sheet is
the same web code on both):** a test account whose lives staff cut twice within 90 days (two cuts
through `/admin/moderation`, the app's own path) opens the live sheet. It closes when the sheet
shows "Vous ne pouvez plus lancer de live jusqu'au <date>" with the date 30 days after the second
cut, Start is greyed, and the session's log carries `[LIVE] standing` and NO `[LIVE] start`. Read
again in English. The same sheet on an account in good standing still offers Start.

**Read 2026-11-15 on dev (`1.7.0-alpha.1`, build `dev.bacebc1`) on a WEB seat, not a phone - PASS for the sheet, PARTIAL for the staging** ([device-verification](../device-verification.md#the-web-seat-and-production-readings-of-2026-11-15-on-170-alpha1)). The account was a rig account that had NO cut on record (`live_cuts` held 0 rows on dev), so the two cuts were STAGED AS TWO FIXTURE ROWS written as the cut path writes them (strikes 1 and 2, the second dated the day before) - NOT through `/admin/moderation`, which would have needed two live broadcasts whose start push reaches the followers' phones. Seen, with the control first and last:
- **Control, good standing:** composer, "En direct", the sheet: Start enabled, no standing line.
- **Suspended, French:** "Vous ne pouvez plus lancer de live jusqu'au 14 décembre." (the second cut's date plus 30 days) with "Réessayer" beside it, Start greyed (`disabled`), and the console carrying `[LIVE] limits`, `[LIVE] rules`, `[LIVE] standing` and NO `[LIVE] start`.
- **Suspended, English:** "You can no longer start a live until December 14." with "Try again", Start greyed, the same three console lines and no `[LIVE] start`.
- **Control after the rows were deleted** (`live_cuts` back to 0): Start enabled, no line.
**Left: the same sheet in a phone's WebView (the entry's own premise, "one phone is enough"), and the two cuts through `/admin/moderation` instead of fixture rows.** The web code is shared, so a phone read is expected to repeat this; it has not been taken.

**iPhone 12, 2026-11-16 (`1.7.0-alpha.2`): the phone WebView half PASSES** (the sheet said "Vous ne pouvez plus lancer de live jusqu'au 15 décembre." with Start greyed, then offered Start once the fixture rows were deleted; [readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-170-alpha2-the-all-entries-sitting)). **Left: the two cuts through `/admin/moderation` instead of fixture rows.**
