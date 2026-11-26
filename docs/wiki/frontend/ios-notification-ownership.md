# iOS: one notification per message, whichever process draws it

Decided 2026-11-22 for `1.7.3` (the backlog entry, closed by [its reading on `1.8.2`](../device-verification.md#the-iphone-12-readings-of-2026-11-26-evening-182-build-100800209-five-iphone-entries-and-a-read-withheld-until-the-first-touch)).
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

`announced_messages.json` in the App Group store, read and written only through
`mobile::announced::with_ledger` (Rust, one implementation linked into the app and the extension)
under an OS file lock (`announced_messages.lock`, `flock`), each write a whole file renamed into
place. It is **sealed** under the install's native cache key (`native_cache`,
`Purpose::AnnouncedLedger`, held with the other sealed caches in `nativeCacheSeal.test.ts`): it names
conversations and senders, which the app's own stores seal, in a file the extension writes with the
app shut. The extension and the app's Objective-C pass the key they read from the Keychain; the
page's command reads it through `app_cache_key`. Every locked edit holds **background time**
(`app_group::BackgroundTime`): the page claims exactly while the app is leaving the screen, and an
app suspended holding a shared-container lock is killed (`0xdead10cc`).

A key is `<conversation>:<sender>:<instant>` - the sender lowercased, the sender's instant for an MLS
message, the server `createdAt` for a salon, all three carried unchanged by the push and by the
socket frame (the push's `senderId` and the frame's are the server's one account id). The sender is
in it so two members writing in the same millisecond are two messages; a message with no sender or
no instant is not keyed, and not claimed. Android's alerted ledger has keyed the same triple since
1.8.2 (`push/AlertedMessage.kt`, shared by the set and by the shade's line match, the sender kept
in a `MessagingStyle.Message` extra): a trigger that does NOT know the sender (a blind salon push)
matches any sender, so a push and a frame of one message stay one, and keys of the older two-part
format never match (read as unknown, aged out of the 128-key bound: at worst one message announced
again). No text is written. Bounded at 512 keys, oldest dropped.

Three writers, and their transitions (`mobile/announced.rs`, every one asserted there):

| writer | when | what it writes | what it does |
| --- | --- | --- | --- |
| extension (`claimAnnouncement`, called by `finish` only) | it hands over a decrypted message (MLS) or any salon message | the key, `by: extension`, unless present | `first`: its banner is the announcement. `after-page`: it files its own quietly (passive, no sound) and, after the handoff, removes the page's banner standing for THAT message ALONE (the page stamps its keys under `__EXTRA__.announces`). Stamps `canariAnnounced` + `canariAnnounceKey` on the push |
| page (`claim_message_announcement`) | right before it posts, after every other refusal | its banner's keys (a catch-up flush covers N) | one key nobody holds: raise, and every key becomes `by: page`. None fresh: raise nothing, and mark the extension's keys `wanted` |
| app `willPresent`, ACTIVE (`CanariSettleAnnouncedInFront`) | a push the extension stamped `first` reaches an active app | settles that key | `wanted`: the page stood down for it - PRESENT the push. Not wanted: answer `None` and REMOVE the key, so the page announces it if the reader cannot see it. `by: page`: `None`. ABSENT (the bound dropped it, perhaps after the page stood down): PRESENT it and record it as the extension's again - at worst a double, never a loss. `after-page`: keep it in the list only |

Why every interleaving ends with exactly one surface: an extension banner is NOT shown in exactly one
case - an active app answers `None` - and that answer is given in the same locked step that gives
the claim back or, if the page already stood down, presents the push instead. Killed, suspended or
inactive, no `None` is answered and the claim stands, so the page's later ask stands down. That is
the cold-launch and resume defect closed, by a record rather than a clock.

### The claim and its stamp reach the app together, or not at all (review of #3968)

The extension claims in `finish`, under `deliveryLock`, in the step that takes the content handler -
never during the decrypt. The expiry (`serviceExtensionTimeWillExpire`) delivers the best attempt
UNSTAMPED and claims nothing. So either the expiry went first, the run claims nothing and the page
may announce the message again (a double, never a loss), or the expiry waits on the lock and finds
nothing to deliver. A claim made during the decrypt could be followed by the expiry's unstamped
delivery: the ledger "the extension's", no stamp for `willPresent`, the page standing down, an active
app answering `None` - the message seen nowhere. The Keychain key and the App Group directory are
read BEFORE the lock; the page's twin is removed AFTER the handoff.

**Why `willPresent` does not look up an unstamped push.** No claim of a run exists without its stamp
(above), so "held by the extension, push unstamped" cannot come from one run. A RETRIED push of a
message an earlier run already claimed and delivered stamped may arrive unstamped (its own expiry):
the earlier banner was the announcement. And an MLS push carries its instant only inside the
ciphertext, so `willPresent` could not build its key anyway.

**What is left: a kill between the claim and the handoff.** Jetsam ends an extension for its memory,
which peaks during the decrypt and the image work, all done before `finish`; between the ledger's
rename and `handler(content)` the run allocates nothing but a log line. If it is killed there, iOS
delivers the push's ORIGINAL payload, unstamped, while the key reads "the extension's":

- **app not active** (killed, suspended, inactive): iOS shows that original payload - the server's
  generic text - so the reader is told, and the page standing down for the key costs nothing;
- **app active**: `willPresent` finds no stamp and the push is answered as an unclaimed one (not
  presented, the page holding the socket), while the page stands down for the key. **This is the
  known residual loss: an unacknowledged push to an ACTIVE app, plus a jetsam kill between the
  ledger rename and the handoff.**

Nothing here can tell that kill apart from a banner the reader swiped (the notification centre
forgets both), so the window is closed by keeping it empty, not by a second record.

**A page banner covering several messages is never removed.** The extension's `after-page` replace
removes only a page banner whose `announces` is exactly its one key. A catch-up banner standing for
three messages stays, and the extension's quiet banner sits beside it: removing it would take the
other two out of Notification Center.

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
- **The extension's `after-page` replace** removes the page's banner only while it is delivered, and
  only when it stands for that one message; otherwise the quiet push row is a second, silent entry.
- **An expiry before the claim** delivers the extension's banner unstamped and unclaimed, so the page
  may announce the message again: a double.
- The ledger is not part of the factory wipe's App Group list (the extension's other caches are not
  either); it holds conversation ids and instants only.

## Logs, one line per decision

- page: `[NOTIF] Raised for <conv> - N message(s) nobody had announced.` /
  `[NOTIF] Not raised for <conv> - every message of it was announced already (by the extension: x, by this app: y).`
- extension: `[CanariNSE] [ANNOUNCED] shown first by the extension` / `... the app announced it first - this banner replaces the app's, quietly` / `... the app announced it first, in a banner that also stands for other messages or is gone - this one is filed quietly beside it` / `... the app's banner of this message: N removed, replaced by this one`
- app: `[CanariPush] [ANNOUNCED] push in front: ...` (presented, claim given back, the app's banner announces it, its key left the ledger, or the ERROR of a ledger that could not settle)
- removal: `[CanariPush] cancelConversationNotification group=<id> removed=N` (unchanged).

## Read on the iPhone

Every row read on the iPhone 12, `1.8.2` ([the sitting](../device-verification.md#the-iphone-12-readings-of-2026-11-26-evening-182-build-100800209-five-iphone-entries-and-a-read-withheld-until-the-first-touch)): a killed-app
push then a cold launch, and a background push then a warm resume, each left ONE row with its time
unchanged; a group's three rows (one of them the page's banner) went with it (`removed=3`); a
foreground group message raised the page's banner, titled by the group.
