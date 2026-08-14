# Legacy compatibility - what to delete once every client is current

Every entry here is a branch that exists ONLY to keep working against a client too old to speak the
current protocol. Each one is dead weight the day the last such client is gone, and each one is a
place where a future reader has to reason about two protocols at once.

**Why this file exists rather than a comment per site.** A compatibility shim is invisible once it
works: nothing fails, nothing warns, and the condition that would retire it is never re-checked. So
the condition is written down HERE, next to the thing it retires, and the removal becomes a decision
somebody takes rather than an archaeology exercise. Every shim below also carries a comment at its
site pointing back here.

**The gate is the same for all of them:** the store rollout has reached the devices, `minClientVersion`
has been raised past the release that introduced the replacement, and the fleet is confirmed on it -
not merely "the release is out". `minClientVersion` is the mechanism that makes the claim true: while
it sits below that release, an old client is not just possible, it is *supported*.

---

## Open

### `remove_reaction` as a system event - since v0.14

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the
`remove_reaction` branches.
**Shim:** both branches translate the old frame into `applyReaction(..., removed = true)`, dated
with the entry's own delivery time because that frame shape carries no timestamp of its own.
**Replacement:** taking a reaction back is the SAME `ReactionMsg` that placed it, with `removed`
set - so both legs of one operation have one shape and both carry the `at` the merge orders on.
**On removal:** delete both branches, and drop `remove_reaction` from the silent-event list in
`proto_fields.rs`.
**What makes this one different:** no client sends the old frame after the rollout, but the shared
history stream still HOLDS entries written before it, so these branches are decoding data at rest,
not humouring a live peer. The condition to retire them is therefore the retention window elapsing
past the rollout, on top of the usual `minClientVersion` gate.
**Cost of keeping it:** a removal replayed from an old stream entry is ordered by its delivery time
rather than by the sender's clock. Only distinguishable if a placement and its removal were sent
within the same delivery, which cannot happen - the outbox serialises them.

### `read_receipt` naming message ids - since v0.14

**Site:** `systemMessageHandler.ts` (live) and `historySystemEvents.ts` (replay), the `read_receipt`
branches; and the per-message `readBy` / `readAt` still sitting inside encrypted rows written before
the change.
**Shim:** a receipt is translated into a watermark - the latest instant among the named messages
THIS DEVICE HOLDS. An id it does not hold contributes nothing, which is the only honest reading: the
frame names messages, and without one there is no instant to compare against.
**Replacement:** `read_watermark`, one monotone instant per participant merged as `max`. See
[history-reconciliation](protocols/history-reconciliation.md#read-state-becomes-a-watermark).
**On removal:** delete both branches and the `event === 'read_receipt'` half of their conditions.
Nothing else has to move - the stored `readBy`/`readAt` are already ignored on read, and the
watermark column is additive (SQLite v6).
**Same shape as `remove_reaction` below:** the shared history stream still HOLDS receipts written
before the rollout, so the branches decode data at rest, not a live peer. Retire them when the
retention window has elapsed past the rollout, on top of the `minClientVersion` gate.
**Cost of keeping it:** a receipt for messages this device never had reads as no read state at all,
where the sender did read something. It corrects itself on the next watermark that peer sends.

### `history_bundle` with no `since` - predates v0.14

**Site:** `sendHistoryBundleForIds` (`groupActions.ts`).
**Shim:** a bundle whose ask stated no window is answered UNCLIPPED (`since` defaults to 0). Two
senders are entitled to that: the invite push, which nobody asked for, and a client too old to state
a window. Neither has declined anything, so clipping their answer would be inventing a boundary on
their behalf.
**Replacement:** every ask - `history_digest`, `history_pull`, `history_range` - carries the asker's
own `since`, and the answer is clipped to the one it was given. The digest itself is never clipped:
it says what a device HAS, while `since` says what the asker WANTS.
**On removal:** make `since` required on the ask and treat its absence as malformed.
**Cost of keeping it:** an old client is served more than it asked for, which it will store or
ignore. Bandwidth, never correctness.

### `GET /api/mls/history/:groupId` answering with a bare array - since v0.14

**Site:** `MessagingController.getHistory` (the body stays `Record<string, unknown>[]`, with the
stream head in the `X-History-Head` response header) and `MlsDeliveryApi.fetchHistory` (a page whose
`head` is `undefined` walks unbounded, exactly as before).
**Shim:** the head travels in a HEADER rather than in the body, so that every deployed client - all
of which `JSON.parse` the response straight into an array - keeps working unchanged. The batch route
had no such constraint: its response was already an object, so `heads` is simply an added field.
**Replacement:** the page IS `{ rows, head }`, one shape for both routes, and the head is not
optional - a walk always knows its upper bound.
**On removal:** return `{ rows, head }` from the GET, delete the `res.setHeader` and the
`@Res({ passthrough: true })` it needs, drop `X-History-Head` from `exposedHeaders` in
`main.ts`, and make `HistoryPage.head` required.
**Why the header needs the CORS entry:** the app runs cross-origin under Tauri
(`http://tauri.localhost`), and a response header that is not in `Access-Control-Expose-Headers` is
invisible to the client that reads it. Without that line the bound would have been silently absent
on mobile only - green build, green deploy, wrong behaviour.
**Cost of keeping it:** two shapes for one concept, and a head that is typed optional at every use
site even though the server always sends one. No correctness cost: a missing head means an unbounded
walk, which is what every client did before the bound existed.

---

## Closed

Move an entry here with the date and the release that made it safe, rather than deleting the entry
outright - the next reader wants to know the shim existed and why it could go.

### `history_bundle` with no `to` - retired 2026-08-12 by the history-reconciliation rework

**Not retired by a rollout: the thing it protected was deleted.** The shim existed so that an
unaddressed bundle could still DISCHARGE the receiver's durable awaiting-history marker. There is no
marker. `systemMessageHandler.ts` now ingests every bundle it can decrypt and reads the addressee for
one log line only - an answer meant for a peer is simply free messages, and what this device holds is
compared again on its next connection. `isSolicitInFlight` no longer exists.

### `history_request` with no `withDigest` - retired 2026-08-12 by the history-reconciliation rework

**Deleted as a CLEAN BREAK, on the user's explicit decision** (*"finalement, pas besoin de conserver
le legacy cette fois"*), not because the fleet had updated. `withDigest` is gone from the election
frame (`messaging.service.ts`, where only a comment now names it) and `requesterHasDigest` is gone
from `actions.ts`. A responder now waits for the MLS probe and answers what the probe asks for.

**The consequence, which is live during the store rollout and must not be mistaken for a defect:**
a 0.14 responder that receives no probe answers NOTHING (`actions.ts`, `handleHistoryRequest`:
*"no probe ... - nothing to answer"*), and a 0.13.0 requester sends no probe. So an old requester gets
silence from an updated peer where it used to get a whole-store dump. It degrades history repair for
clients that have not updated; it cannot corrupt anything. **The remedy is to finish the rollout and
raise `minClientVersion` past 0.14 - never to restore the branch.**

Note the asymmetry that made the deploy order not matter here: this hazard is client↔client. The
SERVER remained compatible with a 0.13.0 client throughout (no endpoint, DTO, proto field or
retention constant changed), which is why shipping it before the stores was survivable.
