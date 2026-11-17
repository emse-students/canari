## P2 - The notifications list is not re-read when a push opens it while it is already mounted

target: 1.7.0

_2026-11-17, scope cut: KEPT in `1.7.0` - the `onMount`-only read predates `v1.6.12`, but the pushes that met it, `live_suspended` and `live_withdrawn`, are new in `1.7.0` ([decisions](owner-decisions-of-2026-11-17.md))._

Read on the Mi 9T, `1.7.0-alpha.8`, 2026-11-17 ([readings](../device-verification.md#the-phone-readings-of-2026-11-17-170-alpha8-both-phones-one-sitting)): the app in the background on
`/notifications`, the `live_suspended` and then the `live_withdrawn` push tapped. The page logged
`[notifNav] deep link received: fr.emse.canari://notifications -> /notifications` and the resume
lines, but no `GET /api/posts/notifications`: both bell rows existed on the server and were missing
from the list more than 20 s after the tap; leaving the page and coming back drew them. The list is
read in `onMount` only (`frontend/src/routes/notifications/+page.svelte`), and the bell's 60 s poll
is not mounted on that page, so a navigation to the route it already shows reads nothing. Any push
whose target is `notifications` (the three live sanctions, the birthday notice) lands on a stale list
in that state. The fix belongs where the list is read: the arrival of a push for the list (or the
route being re-entered) must re-read it, not a timer.
