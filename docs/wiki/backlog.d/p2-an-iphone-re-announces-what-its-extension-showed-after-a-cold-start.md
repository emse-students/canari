## P2 - an iPhone re-announces what its extension showed after a cold start (2026-11-14; prior attempt: PR #2844, branch kept)

target: 1.7.3

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

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
