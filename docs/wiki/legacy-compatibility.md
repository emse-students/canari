# Legacy compatibility - the shims still standing, and the date each one may go

Every entry here is a branch that exists ONLY to keep working against something older than the
current protocol. Each one is dead weight the day its condition is met, and each one is a place where
a future reader has to reason about two protocols at once.

**Why this file exists rather than a comment per site.** A compatibility shim is invisible once it
works: nothing fails, nothing warns, and the condition that would retire it is never re-checked. So
the condition is written down HERE, and the removal becomes a diary entry somebody acts on rather
than an archaeology exercise. Every shim below also carries a comment at its site pointing back here.

**Nothing below is WORK.** Each entry is a date, and the code change behind it is minutes. What is
being waited on is the world, not a decision - do not "do" these early, and do not re-argue them.

---

## What the 2026-08-17 gate actually retired, and what it did not

`minClientVersion` went to **0.14.0** on 2026-08-17. The gate is hard - `ensurePlatformAllowsUnlock`
blocks the MLS unlock outright, so a client below it cannot put a group frame on the wire at all.

It was assumed at the time that this retired most of this page. **Measured, it retired exactly one
entry**, and the distinction is worth keeping because it is the one this page was getting wrong:

- **A shim that humours a LIVE PEER is retired by the gate.** Only one was:
  `history_bundle` with no `since`, deleted 2026-08-17.
- **A shim that decodes DATA AT REST is not**, whatever the fleet is running. The bytes were written
  before the change and they are still there; the gate says nothing about them. Four entries below.
- **A shim that protects the SERVER's response shape is not either**, because the replacement has
  never shipped. One entry below, and it has no date for that reason.

**And a date is only worth what the mechanism under it is worth.** These four were dated on the claim
that `history:{groupId}` expires after `RETENTION_WINDOW_MS`. It did not: the key carried a TTL
*refreshed on every write*, and `HISTORY_STREAM_MAXLEN` bounds the entry COUNT, so a group under the
cap kept every row it had ever held, for ever. Measured on production 2026-08-17: **four of five
streams still carried rows from before 2026-08-15**, at 1 to 11 entries each, in streams nowhere near
the 8 000 cap. The write path now trims by `XTRIM ... MINID` at `RETENTION_WINDOW_MS`
(`messaging.service.ts`), which is what makes the dates below mean something.

**One deliberate break, recorded here so it is not read as an oversight.** `DELETE
/api/channels/workspaces/:id` requires a `confirmationName` since 2026-08-18, and a client that does
not send it is refused. No shim was written on purpose: that route stopped archiving and now destroys
a community outright, while older clients still ask "are you sure?" in the words of the reversible
action. Accepting their call would let them destroy something behind a warning that no longer
describes it, so the missing argument IS the protection - see
[social-service](services/social-service.md#deleting-a-community). It retires itself when no client
below 0.15.0 remains; there is nothing to delete when it does.

**And one deliberate NON-break, recorded for the same reason.** `DELETE /api/channels/:channelId`
made the identical archive -> destroy move on 2026-08-20 and took **no** new argument. The rule the
entry above establishes is not "a delete that becomes real needs a token" - it is *check what the
deployed clients are promising before changing what the server means*. Here they were already
promising it: `chat_delete_channel_confirm` has read "Supprimer definitivement le canal #x ?" since
`5babb466` (2026-06-16), the first version of the string that shipped. A gate would have broken
working clients to protect them from a warning that was accurate all along - see
[social-service](services/social-service.md#deleting-a-channel-took-no-new-argument-deliberately-2026-08-20).

---

## The diary

### 2026-11-19 - the two permissions the grid drew and nothing enforced

**Site:** `RETIRED_PERMISSIONS` in
[`permissions.ts`](../../apps/social-service/src/channels/permissions.ts), and the branch that reads
it in `ChannelService.setRoleBasePermissions`.
**Shim:** `channel.access` and `channel.send` were deleted on 2026-08-19. They were in the registry
from the start, drawn as two of the eight rows in the community permission grid, and read by NOTHING
- neither decided any outcome, because a public salon is visible to every member and a private one
to the people in it, and writing is decided per salon by `writePolicy`. Migration 044 stripped them
from `channel_roles.permissions`, and the write path validates against the registry, so they cannot
come back.
**Why a shim at all:** the write path validates the WHOLE list and throws `BadRequestException` on
any unknown key. A client built before the removal still renders eight rows and PUTs all eight on
any toggle, so without this branch every role edit on such a client would 400 over two keys the
server itself had put in its grid. They are therefore DROPPED and the rest applied, which is exactly
what the admin asked for - and anything else unknown still fails the write, because a key the server
cannot name is a client asking for a capability that does not exist.
**On removal:** delete `RETIRED_PERMISSIONS`, the branch, its two tests in
[`role-permissions.spec.ts`](../../apps/social-service/src/channels/role-permissions.spec.ts), and
this entry. The date is read, not argued: `[ROLE] RETIRED_PERMISSION_SENT` fires at warn on every
old-client edit, so if the log is silent across a campaign the fleet has turned over. **If it has
fired, find which client and why before removing the branch** - the guard in the same spec asserts
no retired name is ever reused as a live one, which is the only way this drop could silently delete
a real grant.
**Cost of keeping it:** one array and one filter, and a validation that is not uniform - which is
the real cost, because "unknown keys are refused" now has an exception a reader must look up.

### 2026-11-19 - the pre-MLS send path, and the `content` column it is the only writer of

**Site:** the `else` arm of `MessagingService.sendMessage`
([`messaging.service.ts`](../../apps/chat-delivery-service/src/services/messaging.service.ts)), taken
when a caller posts no `proto`; `QueuedMessage.content`
([`queued-message.entity.ts`](../../apps/chat-delivery-service/src/entities/queued-message.entity.ts));
and the read side, `queued.proto ?? queued.content ?? ''` in `push.controller.ts`.
**Shim:** every client since MLS sends `proto`, a base64 MLS ciphertext. This branch takes
`body.content` with a `type` tag and fans out over `dm_group_members` instead of the device
membership table. Nothing else writes the column.
**What the evidence actually says:** on 2026-08-19 `queued_message` held 817 rows back to
2026-07-28, `proto` non-null on **817**, `content` non-null on **0**. That is strong and it is not a
census - **the queue records only what was UNDELIVERED**, so a legacy message delivered instantly
leaves no row, and it is only evidence for the question it was written to answer. The service log
would settle it, but its window is one container lifetime and a deploy restarts the container: on
2026-08-19 it held six `[SEND]` lines over three hours.
**Why a date rather than a deletion now:** the fleet is mixed by construction - A1's APK carries its
own bundle and a deploy never reaches it - and deleting a send path that one old client still takes
turns a working install into one that cannot send, silently. Three months is one campaign plus the
margin for a phone nobody has updated.
**On removal:** delete the `else` arm, the `content` column (migration), the `?? queued.content`
arm, and this entry. Both sites now log - `LEGACY_CONTENT_PATH` on write and `LEGACY_CONTENT_ROW` on
read, both at warn - so the date is checked by reading whether either ever fired, not by arguing
about it. **If either has fired, the caller is found and fixed before the branch goes**, because
reaching a fallback means the primary path failed.
**Cost of keeping it:** a nullable column on the largest MLS table, and a read-side `??` that made
the column look load-bearing to anyone auditing it - which is how it survived unnoticed until the
storage panel raised the question.

### 2027-02-19 - a server-composed `title` / `body` on social and form pushes

**Site:** `PushContent.legacyTitle` / `legacyBody` in
[`apps/social-service/src/push/push-content.ts`](../../apps/social-service/src/push/push-content.ts),
passed through by `PushService.notifyContent`.
**Shim:** since 2026-08-19 those pushes carry `contentKey` + `actorName` + `contentArg`, and the
device writes the sentence from its own two-language table. Clients built before that read `title`
and `body` and know nothing of the key, so both are still sent, in the wording they had - French for
the post notifications, English for the form reminders.
**Why a shim rather than a clean break:** dropping the two fields does not degrade an old client, it
BLANKS it - `data["body"] ?: ""` on Android, `content.body` left as the empty alert on iOS. Every
phone installed today would show a notification with no text, and nothing would say why.
**Why the date is six months out, not three:** an Android or iOS user updates when their store
decides to. The other entries here are protocol shims between a client and a server that deploy
together; this one waits on app installs.
**On removal:** delete the two fields from `PushContent` and its six builders, have `notifyContent`
call `notify` with empty title and body exactly as the MESSAGE push path already does, and delete
the `?: data["title"]` arms in `CanariFirebaseMessagingService.composeServerNotification`'s caller,
`NotificationService.applyServerContent` and `CanariComposeServerNotification`. All three already
log when they take that arm, so the traffic is measurable before the date rather than guessed at.
**Cost of keeping it:** two short strings per push, and a real hazard the log answers - while both
halves are sent, a key missing from a native table is invisible, because the phone silently shows
the server's wording and it looks deliberate. `nativeStrings.test.ts` is what closes that.

### 2026-11-13 - history rows with no `sender_device_id`

**Site:** `historyTypes.ts` (`HistoryStreamRow.sender_device_id?`) and the `kind === 'own-message'`
arm of the replay's catch in `frontend/src/lib/utils/chat/history.ts`.
**Shim:** the replay skips a row whose `sender_device_id` is this device before offering it to MLS. A
row written before 2026-08-15 has no such field, so it still reaches MLS and is still recognised by
its refusal - `CannotDecryptOwnMessage`, classified at the throw in `mls-core`. That arm is the shim;
the skip is the mechanism.
**Why the field and not `sender_id`:** the archive is ONE stream per group and must hold this
device's own frames, because every other member reads it. The user cannot discriminate - the same
account's other device wrote frames that are both decryptable and wanted. Only the device can.
**On removal:** delete the `ownFramesSkipped++` line in the catch, keep the classification itself,
and make `sender_device_id` non-optional in `HistoryStreamRow`.
**Cost of keeping it:** none in traffic. The old rows are still handed to MLS to be refused, which is
what happened before the field existed; the fix only stopped that from being the design.

### 2026-11-15 - `remove_reaction` as a system event

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the
`remove_reaction` branches.
**Shim:** both branches translate the old frame into `applyReaction(..., removed = true)`, dated with
the entry's own delivery time because that frame shape carries no timestamp of its own.
**Replacement:** taking a reaction back is the SAME `ReactionMsg` that placed it, with `removed` set -
so both legs of one operation have one shape and both carry the `at` the merge orders on.
**On removal:** delete both branches, and drop `remove_reaction` from the silent-event list in
`proto_fields.rs`.
**Cost of keeping it:** a removal replayed from an old stream entry is ordered by its delivery time
rather than by the sender's clock. Only distinguishable if a placement and its removal were sent
within the same delivery, which cannot happen - the outbox serialises them.

### 2026-11-15 - `pin`/`unpin` with no `at`, and a pinned set stored as a bare array

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the `pin`/`unpin`
branches; `mergePinEntries` and `parseStored` in `pinStore.svelte.ts`.
**Shim:** three readings of the same missing clock. An undated frame arriving LIVE is dated on
receipt - later than anything held, the right answer for a frame arriving now and the only one
available. An undated frame REPLAYED is dated by its position in the shared log
(`parseServerTimestampMs`), the best clock a replay has. A `pins` array of bare id strings - the shape
shipped for one commit on 2026-08-16, and the shape of every `canari_pins_*` entry written before it -
is read at `at: 0`, so any dated statement about the same message beats it.
**Replacement:** the frame carries `at` on both legs, exactly as a reaction's two legs do, and the
register is a last-write-wins entry per message with dated tombstones for the unpins.
**On removal:** delete the three `Number(data.at) ||` fallbacks, the `typeof raw === 'string'` arm of
`mergePinEntries`, and the `Array.isArray(parsed)` arm of `parseStored`.
**This one has a SECOND store behind it, and the date does not cover it.** `canari_pins_*` is
`localStorage` on each device, which nothing on the server can reach and no retention window bounds.
The `Array.isArray` arm may only go once every device has rewritten its own entry - which happens on
the first pin change in each conversation - so on the date, delete the two frame-shape fallbacks and
re-read that arm as its own question.
**Cost of keeping it:** an undated pin loses every tie against a dated one, so a device that pinned on
an old client and a device that unpinned on a new one converge on unpinned even if the pin came
second. The user can always pin again; the reverse - a resurrected pin nobody can explain - is the
outcome the dating exists to prevent.

### 2026-11-15 - `read_receipt` naming message ids

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the `read_receipt`
branches; and the per-message `readBy` / `readAt` still sitting inside encrypted rows written before
the change.
**Shim:** a receipt is translated into a watermark - the latest instant among the named messages THIS
DEVICE HOLDS. An id it does not hold contributes nothing, which is the only honest reading: the frame
names messages, and without one there is no instant to compare against.
**Replacement:** `read_watermark`, one monotone instant per participant merged as `max`. See
[history-reconciliation](protocols/history-reconciliation.md#read-state-becomes-a-watermark).
**On removal:** delete both branches and the `event === 'read_receipt'` half of their conditions.
Nothing else has to move - the stored `readBy`/`readAt` are already ignored on read, and the watermark
column is additive (SQLite v6).
**Cost of keeping it:** a receipt for messages this device never had reads as no read state at all,
where the sender did read something. It corrects itself on the next watermark that peer sends.

---

## No date - `GET /api/mls/history/:groupId` answering with a bare array

**The gate does not reach this one, and the page used to claim it did.** Retiring it is not a matter
of which clients are alive: **the replacement has never shipped**. Every deployed client, 0.14
included, reads the head out of `X-History-Head`, so changing the body today breaks the current fleet
rather than an old one.

**Site:** `MessagingController.getHistory` (the body stays `Record<string, unknown>[]`, the stream
head goes in the `X-History-Head` response header) and `MlsDeliveryApi.fetchHistory` (a page whose
`head` is `undefined` walks unbounded, exactly as before).
**Replacement:** the page IS `{ rows, head }`, one shape for both routes, and the head is not
optional - a walk always knows its upper bound. The batch route already has it: its response was
always an object, so `heads` was simply an added field.
**Condition, in order and it is a chain:** ship `{ rows, head }` and a client that reads it in some
release **R**; raise `minClientVersion` past **R**; then delete.
**On removal:** return `{ rows, head }` from the GET, delete the `res.setHeader` and the
`@Res({ passthrough: true })` it needs, drop `X-History-Head` from `exposedHeaders` in `main.ts`, and
make `HistoryPage.head` required.
**Why the header needs the CORS entry, for whoever ships R:** the app runs cross-origin under Tauri
(`http://tauri.localhost`), and a response header absent from `Access-Control-Expose-Headers` is
invisible to the client reading it. Without that line the bound would have been silently missing on
mobile only - green build, green deploy, wrong behaviour.
**Cost of keeping it:** two shapes for one concept, and a head typed optional at every use site
though the server always sends one. No correctness cost: a missing head means an unbounded walk,
which is what every client did before the bound existed.

---

Retired shims are not listed here. Each one's story is in `CHANGELOG.md` at the release that removed
it - `history_bundle` with no `to` and `history_request` with no `withDigest` on 2026-08-12,
`history_bundle` with no `since` on 2026-08-17.
