## Reading owed - a push that opens the notifications list while it is already open shows its new row

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

**Fixed 2026-11-18.** `frontend/src/routes/notifications/+page.svelte` reads the list through one function,
`readList`, called by `onMount` and by `afterNavigate` when the navigation lands on the route it left
(`isReentryOfSameRoute`, `frontend/src/lib/utils/notifications/reentry.ts`): a push tapped on the open list
is a `goto` to the same route, which does not remount. A fresh mount also receives the `afterNavigate`
callback, from another route, and is not a re-entry, so it never reads twice. The rows that arrive are added
to the unread band, never replacing it. Event-driven, no timer.

**The reading owed (`1.7.0` pre-release, each phone):** on `/notifications` with the app in the background, a
push whose target is the list (a sanction or the birthday notice) is tapped: the new row is in the list at
once, and the log shows `[notifications] read list (reentry)` and a `GET /api/posts/notifications`. Opening
the page cold from the same push logs `read list (mount)` once.
