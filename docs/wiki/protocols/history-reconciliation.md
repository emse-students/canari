# History reconciliation

How a device works out that it is missing messages, and gets them.

This page specifies the **replacement** for the `history_request` / awaiting-marker machinery described
in [`mls-recovery-ladder.md`](mls-recovery-ladder.md). That machinery was measured in production on
2026-08-12 and found to be non-terminating; see [What was wrong](#what-was-wrong). Every decision
below was taken with the product owner on that date and is recorded, with what it displaced, in
[Decisions](#decisions-taken) - do not re-litigate one without going back there.

> **Status: SPECIFICATION.** Nothing here is implemented.

---

## Constraints, measured rather than assumed

Read off production on 2026-08-12. They are why the design looks like this, so re-measure before
changing anything that leans on one.

| Fact | Value | Where |
| --- | --- | --- |
| Shared group log | Redis Stream `history:{groupId}` | `messaging.service.ts:681-695` |
| Size cap | `MAXLEN ~ 1000` per group | `messaging.service.ts:683-685` |
| Key TTL | 90 days, **refreshed on every write** | `messaging.service.ts:695` |
| Entry cost | ~431 bytes | `MEMORY USAGE`, prod |
| Redis memory | 2.42 MB used, `maxmemory 1gb`, `volatile-lru` | prod / `docker-compose.prod.yml:45` |
| Redis persistence | **none** - no volume, `appendonly no`, `dir /data` in the container layer | `docker-compose.prod.yml:35-53` |
| Per-device queue | Postgres `queued_message`, **deleted on ACK** | `messaging.service.ts:1941-1945` |
| Excluded from the shared log | Welcome, Commit, and every `silent` frame - reactions, edits, deletes, read receipts, `history_bundle` | `messaging.service.ts:662-678` |

Four consequences drive everything else.

1. **The server is not an archive.** The only shared copy is an unpersisted Redis stream, capped at
   ~1000 entries, evictable under memory pressure, destroyed when its container is recreated.
   Measured span for an active DM: **22.6 hours**. The devices are the archive.
2. **Holding the ciphertext is not the right to read it.** MLS forward secrecy means a device cannot
   decrypt anything from before it joined, and a spent ratchet generation (`secret-reuse`) is gone
   locally. Only a member that decrypted a frame at the time can re-encrypt it. This is the
   irreducible reason a peer exchange exists at all.
3. **No mutation has a shared copy today.** Reactions, edits, deletions and read receipts are
   queue-only and deleted on ACK, so a device that missed one can never obtain it except from a peer
   that still holds it.
4. **The cap is a global budget, not a per-group one.** At ~431 bytes an entry, 1 GB holds ~2.3 M
   entries; ~1000 per group is about right for 2000 active conversations. Raising it means raising
   `maxmemory` - which must not happen before the store is persisted, or the blast radius grows with
   it.

---

## What was wrong

Two separate flags each carried two questions. Both failures have the same shape, and it is the one
already recorded in [`durable-rules.md`](../durable-rules.md): *"is this broken" and "have I already
asked" differ only in lifetime, and using one for the other silences the trigger.*

### The marker carried "something is missing" and "I still owe an ask"

Asking "do we differ?" was expensive, so it was gated on stored evidence:

> expensive to ask → only ask with a reason → the reason must be stored → but the reason is
> **one-shot** (the frame that proves it is consumed by the act of detecting it,
> `history.ts:415-434`: *"the frame itself is about to be consumed and will never fail again to
> remind us"*) → so the store must be durable → so it needs a discharge condition → hence vouching,
> reason ranks, a 30-day horizon, a 15-minute sweep.

And the discharge condition could not be met. A proven marker (`unreadable-frames`) survives any
non-empty bundle and is cleared only by a peer that compares its whole store, answers **empty**, and
is **not itself awaiting**. Measured: both devices of a two-device DM carried the marker for **1.9
days**, so neither could ever vouch for the other. The client says it in its own log:
`ingesting without discharging our own wait`.

### `silent` carried "do not notify" and "do not persist"

`silent` is a UI property - do not raise a notification, do not render as a message. It is also, and
for no reason, the durability switch: `outbox.ts:327` marks **every** control frame silent by
construction, and `messaging.service.ts:674` excludes silent frames from the shared log. That single
overload is why no mutation has a shared copy.

**They are split.** A frame declares *visibility* and *durability* independently, in one place -
`DELIVERY` in `mls-client/frameDelivery.ts`, three named cases: `visible`, `mutation`, `transport`.
Every mutation is durable; reconciliation traffic is not, because it only restates state held
elsewhere and writing it back would be circular - and the log is capped per group, so a 200-message
bundle chunk would evict the very messages it exists to carry.

Two consequences, both handled where the assumption lived:

- the stream now carries silent frames, so each entry records its own visibility. Anything reading
  the stream to *notify* must honour it - `redeliverMissedDuringActivationWindow` re-notifies a
  reactivated device from this stream and would otherwise ring the user for a reaction;
- the client's replay handlers for mutations, dead until now because no mutation reached the
  stream, become the path every mutation takes on replay. See D7.

### Also measured that day

- solicitation fired at **+3 s**, while the device's own inbound drain was still running - a
  difference it was itself in the middle of closing;
- the rendered list froze for ~10 minutes after a large bundle ingest. Nothing was lost - all four
  probe markers were present after a reload - but nothing appeared on screen either.

---

## The model

### Two boundaries, not one

**The conversation floor** - shared, monotone, travels inside the exchange.
: *"The history of this conversation begins here."* Below it nobody claims and nobody answers. It
  only moves forward; when two devices disagree the **larger wins** (a `max`, so it merges without
  coordination). It is what makes pruning safe.
: **Hard constraint:** it may never sit below what some member can still supply, or the system
  promises a completeness nobody can honour.

**The device window** - local, **fixed per platform. Never a user-visible setting.**
: *"What this device intends to retain."* **Web: 90 days. Mobile and desktop: 5 years.**
  Deliberately unequal. Ninety days covers most of a semester, so the browser reaches for
  [scrollback](#scrollback-below-the-window) rarely rather than routinely. Five years is longer than
  the longest tenure anyone has here, so no user meets that bound while they are still a member: it
  exists to keep "everything" finite, not to expire anything anybody will miss.
: Bounded rather than literally infinite for two reasons, neither of them rendering cost - history
  already loads in pages of 60 behind the `afterStreamId` cursor, so the window never reaches the
  renderer. First, an unbounded window gives the floor nothing to move for, ever. Second, the
  [state key](#completeness-is-asked-from-the-requesters-side) is computed over the window, and an
  unbounded domain makes its worst case unbounded too.

### Completeness is asked from the requester's side

A device is complete when it holds everything that exists in

```
[ max(conversationFloor, deviceWindowStart) , now ]
```

so the comparison is always scoped to the **asking** device's window. The phone is never shrunk by
the browser; the browser is never force-fed by the phone.

### The exchange

On connect, in this order - the order is load-bearing:

1. **Connect.**
2. **MLS sync** - join/refresh groups, apply commits.
3. **Drain the mailbox** (`queued_message`) to completion. *Comparing before this finishes reports a
   difference the device is in the middle of closing by itself.*
4. **Then, silently, in the background:** send the elected online peer a compact **state key** for
   the requester's window and ask whether it matches.

The state key covers **the id set and the mutation state** - not ids alone. Two devices agreeing on
which messages exist can still disagree on which are deleted, and both would call themselves
complete. Ids and mutation state only, never content: a deleted message keeps its id and changes its
content, and the two devices must still recognise their agreement.

It is **cached per conversation and invalidated on write**, never recomputed by walking the window.
Connect cost must not grow with retention, or the 5-year window would be paid on every connect for
a comparison that almost always matches.

- **Keys match** → nothing is sent, nothing is displayed. The common case, and it must cost one small
  frame.
- **Keys differ** → then, and only then, exchange the hierarchical digest that already exists
  (`groupActions.ts:636`), and each side sends what the other lacks **within that side's window**.

Election is unchanged: the server picks one online member, so the exchange stays two-party. A
broadcast digest would cost every member a decryption for a repair concerning two devices.

### Why it converges, and why a third device needs nothing extra

Union merge is commutative, associative and idempotent, so repeated pairwise exchanges - any order,
whoever happens to be online - converge to the union. Classic anti-entropy. Propagation to a third
device falls out; nothing to orchestrate, no membership to enumerate.

This holds only while **every merged field is monotone**:

| Field | Merge rule | Monotone |
| --- | --- | --- |
| messages | union by id | yes |
| deletion | tombstone, content purged | yes |
| edit | last-write-wins on the author's `editedAt` | yes |
| reaction | last-write-wins per `(user, emoji)` on its own timestamp | yes |
| read state | watermark, `max` | yes |
| conversation floor | `max` | yes |

Two of these are corrections, not restatements of today's behaviour - see
[Defects this work must fix](#defects-this-work-must-fix), D3 and D5. Pruning is **not** monotone,
which is exactly what the floor is for: pruning below it is invisible to the merge, and pruning above
it is forbidden.

### Reactions

Each `(user, emoji)` pair carries its own timestamp and an on/off state; the larger timestamp wins.
Converges without tombstones, and stays bounded - a place/remove cycle does not grow the set.
Today's rule seeds reactions from a bundle **only when the receiver has none**
(`systemMessageHandler.ts:717`), so a removal never reaches anyone holding a stale reaction.

### Deletion purges

A deletion replaces the content at rest, everywhere it lands, and removes the corresponding entry
from the shared log. What remains is the tombstone. Today the flag is set and the original text is
kept - `systemMessageHandler.ts:724-727` sets `isDeleted` without touching `content`, and the write
at `:762` puts the original plaintext straight back on disk.

### Read state becomes a watermark

One monotone value per participant - *read up to T* - merged as `max`, replacing the per-message
`readBy` array. It goes in the shared log, so a new or reinstalled device recovers its read state
without needing a peer online.

It also removes a hazard in the present shape: because the watermark does not depend on which
messages a device holds, a history catch-up can no longer mark an old message unread.

### Scrollback below the window

To reach past its own window a device asks a peer for a **bounded range** rather than everything,
answered only within the floor. Same frame shape as a reconciliation answer, different trigger: a
user gesture instead of a connection. Without it, pruning on the browser would mean the browser can
never show the old past again.

### Media

Blobs keep their own 30-day idle retention; **text and attachments have different horizons on
purpose**. Text is cheap, blobs are not. Beyond the media horizon the message stays and the
attachment renders an explicit expired state.

---

## Defects this work must fix

Found while specifying, on 2026-08-12. D1, D3 and D5 were read and confirmed directly; the rest come
from the audit and carry its references.

| # | Defect | Where | Confirmed |
| --- | --- | --- | --- |
| D1 | `saveMessage` is a full-row `put` and `toMessagePayload` omits absent fields, so every partial write **erases** the fields it does not carry. Six mutation handlers each pass a different subset - a reaction landing on a deleted message clears the tombstone; a read receipt on an edited message clears `isEdited`. The read-before-write pattern already exists at `history.ts:502-548` | `messagePayload.ts:28-41`, `indexeddb.ts:248-283` | yes |
| D2 | The reading device never persists **its own** read state - the optimistic update is a bare `conversations.set`. After a reload, messages it read return as unread until a peer's bundle hands them back | `MainChatPage.svelte:434-445` | audit |
| D3 | Reaction removal never converges: a bundle's reactions are adopted only when the receiver holds none | `systemMessageHandler.ts:717` | yes |
| D4 | `editedAt` is not serialised into the bundle although `isEdited` is, so a device restored by bundle shows "edited" with no timestamp, permanently | `groupActions.ts:450-465` | audit |
| D5 | Bundle merge flags `isDeleted` without replacing `content`, and writes the original text back to disk | `systemMessageHandler.ts:724-727`, `:762` | yes |
| D6 | `serverTimestamp` is dropped on the live bundle add path, giving unstable ordering for messages sharing a client timestamp. The replay path preserves it | `systemMessageHandler.ts:671-678` | audit |
| D7 | The replay handlers for `reaction`, `read_receipt`, `delete_message`, `edit_message`, `remove_reaction` are unreachable for MLS groups, because those frames never enter the stream. **Inverted by the durability split**: they are now the path every mutation takes on replay, so the work is to verify them rather than delete them | `historySystemEvents.ts:173-238`, `history.ts:378-388` | audit |

Three defects measured the same day are covered here rather than patched separately, by decision: the
stuck `isMessageCatchupActive` overlay, the post-ingest render freeze, and the 15 s `scheduleRetry`
loop that re-raises the overlay.

---

## What disappears

Deleted outright, not deprecated:

- the durable awaiting-history registry **as a trigger** (`awaitingHistoryRegistry.ts`);
- the retry - the next state edge *is* the retry, so there is nothing to re-attempt;
- vouching, reason ranks, `isProvenAwaitingReason`, the 30-day give-up horizon;
- the 15-minute sweep (`AWAITING_SWEEP_INTERVAL_MS`) and `reSolicitAwaitingHistory`;
- the response-window store and the **"history pending" banner**. If a repair is needed and possible
  it happens silently; if no peer is online it does not happen, and there is no waiting state left to
  describe;
- the per-message `readBy` array, replaced by the watermark.

Surviving in a reduced role: a note that a **specific message** was never readable. It drives no
traffic; its only use is telling the user there is a gap.

---

## Transition

**No compatibility layer.** The new mechanism ships as a clean break and `minClientVersion` is raised
to match.

One ordering constraint on the deploy, because it decides whether a forced update works or traps:
raising `minClientVersion` before the stores actually serve the new build locks users in a loop -
update screen → store → same version → update screen. So: publish to the stores, **verify the store
serves the new build**, then deploy the server change and raise the floor.

---

## Decisions taken

With the product owner, 2026-08-12. Each replaced an alternative rejected for the reason given.

| Question | Decision | Rejected, and why |
| --- | --- | --- |
| Completeness | **Unequal and deliberate** - browser recent, phone everything | Equal in a common window: makes the browser pay the phone's storage cost |
| The boundary | **Monotone per-conversation floor**, merged as `max` | Sliding window from "now": two devices never share an instant, so the edge oscillates and re-triggers exchanges. Join date: never restores anything from before a reinstall |
| Scrollback | **Specified and implemented** | Deferring it makes pruning on the browser a permanent loss of access |
| Banner | **Removed** - the repair is silent | It only ever reported a state that should not exist |
| Mutations in the shared log | **All of them**; only `history_bundle` stays out | Keeping them queue-only leaves every mutation single-sourced from a peer |
| Reaction convergence | **Last-write-wins per `(user, emoji)`** | Tombstone set: converges without a clock, but grows on every place/remove cycle |
| Deletion | **Purge the content, keep the tombstone**, drop the shared-log entry | Flag-only: a deletion that deletes nothing |
| Read state | **Watermark in the shared log** | Peer-only: a new device with no peer online starts with everything unread |
| Media | **Text kept, attachment expires** with an explicit state | Aligning the floor on media retention throws away text that costs almost nothing |
| The three measured defects | **Folded into this work** | Patching first fixes symptoms whose common cause this removes |
| Transition | **Clean break, forced update** | Cohabitation: compatibility code to write, maintain and later remove |
| Floor in v1 | **Yes, present from the start**, even while it is worth zero | Adding it later means converging one more field across a deployed fleet, and we keep no compatibility layer - so it would cost a second break |
| Window sizes | **Web 90 days, mobile/desktop 5 years** | 30 days on the web: leans on scrollback for ordinary use. A count rather than a duration: a quiet conversation would keep years and a busy one a few days, which is not what a user expects of "recent". Literally unbounded on mobile: leaves the floor immovable and the state key's domain unbounded |
| Who chooses the window | **Fixed per platform** | A user-visible setting: it is a completeness contract between devices, not a preference, and a user lowering it silently reduces what their other devices can be told |
| What may move the floor | **Nothing, for now** - it ships at zero and the merge rule (`max`) is all that is implemented | Moving it on any schedule: the floor may never sit below what a member can still supply, and with the most retentive platform at 5 years no member prunes for five years. There is nothing to move it *to* |
| Redis durability | **Fixed immediately** - named volume + `appendonly yes` | Deferring it to the rework: the log would stay destructible until then, and the cap cannot be raised before it |

---

## Open questions

Two were closed on 2026-08-12 and moved into [Decisions](#decisions-taken): what may move the floor
(nothing, for now) and who chooses the window (the platform, not the user). What is left:

- **The new cap.** Order is fixed and must be respected: Redis persisted (done) → raise `maxmemory`
  → raise `MAXLEN`. The number needs the mutation budget, which is only known once mutations are
  actually written to the log.
- **State key cost at scale.** Caching it removes the *per-conversation* cost of a large window, but
  not the *fan-out*: one small frame per conversation per connect, for a user in many groups.
  Measure before shipping.
