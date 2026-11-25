## P2 - an iPhone re-announces what its extension showed after a cold start (2026-11-14; prior attempt: PR #2844, branch kept)

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](../decisions/owner-decisions-of-2026-11-17.md))._

**The defect (read from `main`, 2026-11-14).** The Notification Service Extension shows a push and
acknowledges nothing, so its row is redelivered when the app next connects. After a cold start the
in-memory state of the app is empty, and `notifyInbound` (`useMessaging.svelte.ts`) only refuses a
message its account has READ (`isUnreadForUser` against the watermarks): an unread message the
extension already presented passes, and `useNotifications` raises it again as a local notification
under `stableNotifId(conversationId)`, an id per CONVERSATION that is not the extension's request id,
so the second banner does not replace the first. No durable record keyed by message id exists on
`main` (no ledger, no read of the push cache by the notifier), and `getDeliveredNotifications` cannot
be that record, since a tapped or swiped banner leaves it. Neither #3465 (a signed-out cold start sends
no refresh) nor #3027 (a salon push fallback accuses) touches this.

**Why.** Two orderings. The gateway socket opens before the conversation restore (its mailbox barrier
needs it), so the post-connect catch-up (settle, pull, `onCaughtUp`) drained the queue into an empty
conversation map (`absent-conversation`, then a second refetch once the rows were seeded). And on iOS
the drain runs before the push-cache take, so the extension's rows are redelivered while nothing
remembers they were shown.

**Prior attempt: PR #2844, branch `fix/no-renotify-after-cold-start` (kept, 366 commits behind
`main`, conflicting in `canari_ios.mm`, `useMessaging.svelte.ts`, `conversations.ts` and tests; closed
unmerged).** Its design is the reference to redo, not to rebase:

- `BaseMlsService.deferUntilConversationRowsExist(work)` holds the catch-up until
  `notifyConversationRowsSeeded()` (or `notifyConversationsRestored()`), runs the held work in order,
  one try/catch each; restore phase 2 awaits it. Ordering by construction, not by delay.
- A per-account durable ledger `canari_notified_messages:v1:<user>` of message ids, bounded at 2000,
  written by every in-app banner and by the iOS push-cache take; `notifyInbound` raises nothing when
  every id is recorded.
- On iOS `notifyInbound` also peeks the push cache read-only through a `push_cache_message_ids`
  command (data dir and App Group, taken and live files, sealed lines opened with the cache key), so a
  row the extension presented raises nothing even before the take.
- The foreground iPhone banner headed like the extension: title the group or salon, body
  `Sender : text` (`tauri-plugin-notification` 2.7.0 has no subtitle field on iOS).
- Its tests, each run with the fix disabled: the held catch-up, the phase-2 ordering, the once-by-id
  cases, the ledger, the `fcmCache` record and peek, and two Rust tests on the peek.

**What must change on `main` now.** Redo it on today's code: the catch-up waits for the rows; a durable
per-account ledger keyed by message id (principle 1, the message is announced once); the iOS peek of
the push cache before `notifyInbound`; the same title and body shape as the extension. The iOS-only
`cfg` code was never compiled on the prior attempt's machine; it compiles in CI only.

**Owed on the iPhone:** a cold start from a tap shows no `absent-conversation`; no second banner after
a tap from a killed state nor after a background tap and a resume; a foreground group message is titled
by the group; new messages still notify.

**2026-11-22, [I1 sitting](../device-verification.md#the-iphone-12-readings-of-2026-11-22-173-alpha5-the-backup-domains-the-banners-the-reactions-the-replay-bar-the-outage-drill) (`1.7.3-alpha.5`): the defect is reproduced on this build** (two cold launches, one of them through the share notice; details): the notification of a message the extension showed is raised again at the launch (`[NOTIF] Inbound ... asking`), its row jumping to "now". The reading that closes this entry is a cold launch after a killed-app push with that row's time unchanged.

**2026-11-22, `1.7.3-alpha.6` (iPhone 12): still FAILING, and a second defect beside it.** App killed,
Notification Center clean, one DM from `delta`: the extension showed ONE row; a cold launch left TWO
identical rows. A group message the extension had shown ended as THREE rows after a warm resume, the
page's titled `Group: Sender: text`. Then the group was deleted while the app ran: the page logged
`ended - taking its notifications down` and `cancelConversationNotification` removed 1 of the 5
delivered - the extension's; the page's banners carried no `threadIdentifier`. Evidence outside the
repository.

**The fix (branch `fix/ios-one-banner-per-message`), decided as a ledger, not as a single owner:**
whether a catch-up row was pushed is the server's fact, not the page's, so "the page never announces a
catch-up" would be a belief. Both processes claim `<conversation>:<sender>:<instant>` in
`announced_messages.json` (App Group, sealed, one `flock` held with background time, Rust
`mobile::announced`; the extension claims only in the step that hands its content over, so an expiry
never delivers a banner whose claim stands unstamped - review of #3968); the page asks before it
raises (`claim_message_announcement`) and stands down for what the extension drew; an ACTIVE app's
`willPresent`, the one place a push is answered `None`, gives the extension's claim back in the same
locked step (or presents the push when the page already stood down). Every page banner carries
`group: <conversation>` (the extension's thread), so the removal by conversation takes it too. PR
#2844's queue gate and server half are NOT redone: the ledger makes the order of arrival decide
nothing. Design and residuals: [ios-notification-ownership](../frontend/ios-notification-ownership.md).
The readings above are still owed, plus: a group deleted while the app runs leaves none of its rows.
