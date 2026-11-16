## Reading owed - the pre-live screen says a suspension before Start

target: 1.7.0

Built 2026-11-15: the pre-live sheet reads `GET /api/lives/standing` with the limits and the rules,
says a running suspension (with its end date) or a withdrawal, and disables Start
([live](../frontend/modules/live.md#the-broadcaster-as-built)). The sheet itself is READ on a web seat
(French and English), on the iPhone 12 and on the Mi 9T (French), each on a suspended account and on a
control ([web](../device-verification.md#the-web-seat-and-production-readings-of-2026-11-15-on-170-alpha1),
[iPhone](../device-verification.md#the-iphone-12-readings-of-2026-11-16-170-alpha2-the-all-entries-sitting),
[Mi 9T](../device-verification.md#the-mi-9t-readings-of-2026-11-16-the-owed-rows-170-alpha2)).

**What is still owed, one half only:** every one of those readings staged the cuts as TWO FIXTURE ROWS written as the cut path
writes them (strikes 1 and 2, the second dated the day before), never through `/admin/moderation`, the app's own path, which needs
two live broadcasts whose start push reaches the followers' phones. The reading closes when a test account whose lives staff cut
twice within 90 days through `/admin/moderation` opens the live sheet and it shows "Vous ne pouvez plus lancer de live jusqu'au
<date>" (30 days after the second cut), Start greyed. Also unread on the phones: the English wording (read on the web seat only) and the
`[LIVE] standing` / no `[LIVE] start` console lines (a release build prints no console to logcat).
