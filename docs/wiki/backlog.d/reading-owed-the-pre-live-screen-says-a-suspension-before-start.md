## Reading owed - the pre-live screen says a suspension before Start

target: 1.7.0

Built 2026-11-15: the pre-live sheet reads `GET /api/lives/standing` with the limits and the rules,
says a running suspension (with its end date) or a withdrawal, and disables Start
([live](../frontend/modules/live.md#the-broadcaster-as-built)). The sheet itself is READ on a web seat
(French and English), on the iPhone 12 and on the Mi 9T (French), each on a suspended account and on a
control ([web](../device-verification.md#the-web-seat-and-production-readings-of-2026-11-15-on-170-alpha1),
[iPhone](../device-verification.md#the-iphone-12-readings-of-2026-11-16-170-alpha2-the-all-entries-sitting),
[Mi 9T](../device-verification.md#the-mi-9t-readings-of-2026-11-16-the-owed-rows-170-alpha2)).

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

**Web rig, 2026-11-16 (dev `1.7.0-alpha.2`, build `dev.9ca790c`) - the staging remainder through `/admin/moderation`: PASS.** Beta (W7, fake camera and microphone) started a live ("Web1700 live A"); alpha (W6) reported it from the live viewer ("Signaler ce live", Spam); gamma (W8, global admin) opened `/admin/moderation`, "Couper le live", Spam, "Continuer", "Couper le live": the server wrote `[LIVE_CUT] ... reason=spam ... priorCuts=0 strike=1 consequence=warning` and the `live_cut` notice and push to the broadcaster. A second live ("Web1700 live B") was reported and cut the same way: `priorCuts=1 strike=2 consequence=suspended`, `live_suspended` notice. Beta's pre-live sheet then read, in French, "Vous ne pouvez plus lancer de live jusqu'au 16 decembre." (the second cut's day plus 30), in English "You can no longer start a live until December 16.", Start greyed (`disabled`) in both, and the console carried `[LIVE] limits`, `[LIVE] rules`, `[LIVE] standing` and no `[LIVE] start`. The two `live_cuts` rows were then deleted (dev write, `WRITTEN-IDS.txt`) and the same sheet offered Start again (`standing` null, Start enabled): the control after. **Side effects:** beta's follower alpha (the Mi 9T's account) was pushed once for live B's start (`[LIVE_ANNOUNCE] ... kind=member followers=1`); live A's announce line was not found in the 40-minute log window. **What this web read closes:** the two cuts through `/admin/moderation`, the English wording and the console lines, ON THE WEB. **STILL OWED, on the phones only:** the English wording on a phone's WebView (the iPhone read of 2026-11-16 was French only), and the `[LIVE] standing` and absent `[LIVE] start` console lines on a phone (the iPhone's was not on disk when its log was pulled; the Mi 9T has not read the sheet). The sheet's code is shared with the web, so a phone read is expected to repeat this; it has not been taken.

**iPhone 12, 2026-11-16 (`1.7.0-alpha.2`): the phone WebView half PASSES in French** (the sheet said "Vous ne pouvez plus lancer de live jusqu'au 15 décembre." with Start greyed, then offered Start once the fixture rows were deleted; [readings](../device-verification.md#the-iphone-12-readings-of-2026-11-16-170-alpha2-the-all-entries-sitting)). (The `/admin/moderation` cuts were then read on the web, above.)

**What is still owed, one half only:** every one of those readings staged the cuts as TWO FIXTURE ROWS written as the cut path
writes them (strikes 1 and 2, the second dated the day before), never through `/admin/moderation`, the app's own path, which needs
two live broadcasts whose start push reaches the followers' phones. The reading closes when a test account whose lives staff cut
twice within 90 days through `/admin/moderation` opens the live sheet and it shows "Vous ne pouvez plus lancer de live jusqu'au
<date>" (30 days after the second cut), Start greyed. Also unread on the phones: the English wording (read on the web seat only) and the
`[LIVE] standing` / no `[LIVE] start` console lines (a release build prints no console to logcat).
