# iOS: one notification per message, whichever process draws it

Decided 2026-11-22 for `1.7.3` ([backlog entry](../backlog.d/p2-an-iphone-re-announces-what-its-extension-showed-after-a-cold-start.md)).
Principle 2 ("the essential is never lost") and the standing directive ("deterministic, reproducible,
explicable") are the constraints: no message may go unannounced, and no message may be announced
twice, whatever the order in which two processes see it.

## The defect, read on the iPhone 12 (`1.7.3-alpha.6`)

Two processes can draw the same message on an iPhone:

| | the notification extension (`canari_NSE`) | the page (`useNotifications`, `tauri-plugin-notification`) |
| --- | --- | --- |
| triggered by | every alert push (the server pushes a frame the device has not ACKed: offline, or 10 s after a socket publish) | a frame the page takes while the reader cannot see it land (`notifyInbound`) |
| shown when | always when the app is killed, suspended or inactive; an ACTIVE app answers `willPresent` with `None` | the plugin posts at once |

The extension acknowledges nothing, so its row is redelivered at the app's next connection, and the
page announced it again. Read: one DM with the app killed - ONE row; a cold launch - TWO identical
rows. A group message the extension had shown - THREE rows after a warm resume. And when that group
was deleted, `cancelConversationNotification` removed 1 of the 5 delivered: the page's banners had no
`threadIdentifier`, and the removal is keyed on it.

## Why neither a clock nor the notification centre answers it

- Nothing in memory survives the kill, and "did the extension show this?" is asked after a launch.
- `getDeliveredNotifications` cannot be the record: a tapped or swiped banner leaves it, and a
  launch by a tap is exactly the case.
- "Single owner by app state" (the page never announces a catch-up) is a belief about the server,
  not a fact: whether a row was pushed depends on the deferred push and the ACK, which the page does
  not see. A rule built on it is right only as often as the belief.

## The design: a ledger both processes write, and one place that knows "not shown"

`announced_messages.json` in the App Group store, written only through `mobile::announced::with_ledger`
(Rust, one implementation linked into the app and the extension) under an OS file lock
(`announced_messages.lock`, `flock`), each write a whole file renamed into place. A key is
`<conversation>:<instant>` - the Android alerted ledger's key (`CanariFirebaseMessagingService.alertedKey`):
the sender's instant for an MLS message, the server `createdAt` for a salon, both carried unchanged by
the push and by the socket frame. No text is written. Bounded at 512 keys, oldest dropped.

Three writers, and their transitions (`mobile/announced.rs`, every one asserted there):

| writer | when | what it writes | what it does |
| --- | --- | --- | --- |
| extension (`claimAnnouncement`) | it draws a decrypted message (MLS) or any salon message | the key, `by: extension`, unless present | `first`: its banner is the announcement. `after-page`: it removes the page's banner of that message (the page stamps its keys under `__EXTRA__.announces`) and files its own quietly (passive, no sound): one row, one alert. Stamps `canariAnnounced` + `canariAnnounceKey` on the push |
| page (`claim_message_announcement`) | right before it posts, after every other refusal | its banner's keys (a catch-up flush covers N) | one key nobody holds: raise, and every key becomes `by: page`. None fresh: raise nothing, and mark the extension's keys `wanted` |
| app `willPresent`, ACTIVE (`CanariSettleAnnouncedInFront`) | a push the extension stamped `first` reaches an active app | settles that key | `wanted`: the page stood down for it - PRESENT the push. Not wanted: answer `None` and REMOVE the key, so the page announces it if the reader cannot see it. `by: page`: `None`. `after-page`: keep it in the list only |

Why every interleaving ends with exactly one surface: an extension banner is NOT shown in exactly one
case - an active app answers `None` - and that answer is given in the same locked step that gives
the claim back or, if the page already stood down, presents the push instead. Killed, suspended or
inactive, no `None` is answered and the claim stands, so the page's later ask stands down. That is
the cold-launch and resume defect closed, by a record rather than a clock.

**A failure is said, and never costs the message.** The page's ask failing (`Err`) raises the banner
with an ERROR line ("it may repeat what the extension showed"). The settle failing in `willPresent`
presents the push (its claim stands, so the page would stand down). The extension's claim failing is
logged at error and the page may announce it again.

## Every page banner is filed under its conversation

On iOS the page's plugin post carries `group: <conversation>` (the plugin's `threadIdentifier`) and
`extra: { groupId, announces }` (`userInfo.__EXTRA__`), for messages and reactions alike. The removal
by conversation (`cancel_conversation_notifications`, keyed on the thread; the read hand-over and the
ended-conversation watcher, [social-service](../services/social-service.md)) now takes the page's banners
with the extension's.

## What is left, named

- **An undecrypted MLS banner carries no instant** (the extension's fallback text): it is not
  claimed, so the page may draw the real message after it - a second row for one message. Android
  replaces the generic line (`supersedes`); iOS has no such replace yet.
- **The extension's `after-page` replace** removes the page's banner only while it is delivered; a
  page banner the reader already swiped leaves the quiet push row as a second, silent entry.
- The ledger is not part of the factory wipe's App Group list (the extension's other caches are not
  either); it holds conversation ids and instants only.

## Logs, one line per decision

- page: `[NOTIF] Raised for <conv> - N message(s) nobody had announced.` /
  `[NOTIF] Not raised for <conv> - every message of it was announced already (by the extension: x, by this app: y).`
- extension: `[CanariNSE] [ANNOUNCED] shown first by the extension` / `... the app announced it first - this banner replaces the app's, quietly` / `... the app's banner of this message: N removed, replaced by this one`
- app: `[CanariPush] [ANNOUNCED] push in front: ...` (presented, claim given back, the app's banner announces it, or the ERROR of a ledger that could not settle)
- removal: `[CanariPush] cancelConversationNotification group=<id> removed=N` (unchanged).

## Owed on the iPhone

The backlog entry's readings: a killed-app push then a cold launch leaves ONE row with its time
unchanged; the same after a background push and a warm resume; a group deleted while the app runs
takes every one of its banners (`removed=` equals what it held); a foreground message for another
conversation still raises the page's banner.
