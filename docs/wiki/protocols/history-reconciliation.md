# History reconciliation

How a device works out that it is missing messages, and gets them.

This page specifies the **replacement** for the `history_request` / awaiting-marker machinery described
in [`mls-recovery-ladder.md`](mls-recovery-ladder.md). That machinery was measured in production on
2026-08-12 and found to be non-terminating; see [What was wrong](#what-was-wrong). Every decision
below was taken with the product owner on that date and is recorded, with what it displaced, in
[Decisions](#decisions-taken) - do not re-litigate one without going back there.

> **Status: IMPLEMENTED.** Everything specified here is shipped - D1-D7, the durability split, the
> read watermark, the conversation floor + device window, the `since` clipping, the state key and its
> cache, the reconciliation exchange on connect, the scrollback, the deletions under
> [What disappears](#what-disappears), and the three measured defects.
>
> **Green gates are all that has been established.** Not one line of it has run on a device or in a
> browser: the frontend suite passes and `svelte-check` reports nothing, which proves it compiles and
> that its units behave, and says nothing about a real conversation between two real devices. The
> [cross-client campaign](../cross-client-campaign.md) is what would, and it is owed from MSG-1 on this
> build.

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
| Redis memory | `maxmemory 2gb`, `volatile-lru` (only keys carrying a TTL are ever evicted) | `docker-compose.prod.yml:62-71` |
| Redis persistence | **AOF on a volume** since 2026-08-12 (`--appendonly yes`, `redis_data:/data`); it was none before, and the stream died with the container | `docker-compose.prod.yml:45-73` |
| Per-device queue | Postgres `queued_message`, **deleted on ACK** | `messaging.service.ts:1941-1945` |
| Excluded from the shared log | Welcome, Commit, and every `silent` frame - reactions, edits, deletes, read receipts, `history_bundle` | `messaging.service.ts:662-678` |

Four consequences drive everything else.

1. **The server is not an archive.** The only shared copy is a Redis stream, capped per group and
   carrying a TTL - so evictable under memory pressure. It was also destroyed whenever its container
   was recreated, until the volume of 2026-08-12 (measured span for an active DM before it: **22.6
   hours**). The devices are the archive.
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

## What a connection pass costs, measured

Measured on an Android device against production, 2026-08-13, nine local groups. The pass is the
connection trigger: `initializeConnection.ts` calls `reconcileAllGroups` over every local group once
the mailbox has drained.

| Fact | Value |
| --- | --- |
| Cost of one group | **~480 ms**, almost all of it the `sendHistoryRequest` election round trip |
| Cost of the pass, sequential | **4.35 s** for 9 groups |
| Cost of the MLS encrypt + send | not separable from zero - `[HISTORY_STATE] Sent` and the `asked` line that follows it land in the same second |
| Reply when the two agree | **nothing at all** - silence is the answer |

```
10:37:13.136  [HISTORY_RECONCILE] asked 66e1b07e…
10:37:13.563  [HISTORY_RECONCILE] asked 4f87267a…        ← ~480 ms apart, strictly serialised
   ...
10:37:16.603  [QUEUE] Drain start groups=1 messages=1    ← the drain starts mid-pass
10:37:17.482  [HISTORY_RECONCILE] reconciliation pass complete - 9 group(s) asked
```

Three things follow, and each corrected a belief that was written down before it was measured.

1. **The probe was never expensive in FRAMES, and always expensive in TIME.** A matching digest costs
   zero reply frames, which was taken to make asking on every connection affordable. **That part of
   the design did NOT hold either, and the sweep is gone** - see the 2026-08-13 row in
   [Decisions](#decisions-taken). The frames were cheap for the *sender* and were counted as an
   arriving backlog by every *receiver*, because a count taken before decryption cannot tell a probe
   from a message; two people talking got a banner and a locked composer out of it. A sweep now runs
   only when the server could have dropped something (`connectionSweepDecision`), which is what makes
   it a heal rather than a heartbeat. What did not hold either is the *shape* of the ask: the
   elections are HTTP, take no MLS
   mutex, and were serialised for a reason that only ever applied to the sends. They now run with a
   bound of 6 in flight (`ELECTION_CONCURRENCY`); the sends still serialise on the mutex as before.
   The bound is not decoration - a device in fifty conversations would otherwise open fifty requests
   on a phone radio at the instant it reconnects.
2. **The inbound drain does not cost what it appears to.** It overlaps the pass and inherits its
   duration, so drain time was flat at ~4 s whether it carried 2 frames or 12. Anything measuring
   "how long a drain takes" on a reconnect is measuring this pass.
3. **Every foreground return paid it.** On Tauri, `visibilitychange: hidden` pauses the connection
   immediately and deliberately (`ChatBackgroundService.svelte`), so an app switch costs a
   reconnect, hence a full pass. Holding the socket open through a short background was considered
   and **rejected**: a message arriving during the grace period would be ACKed over the WebSocket by
   a live-but-backgrounded app, which cancels the deferred FCM fallback
   (`messaging.service.ts`, `scheduleDeferredPush`, 10 s) - and nothing establishes that the web
   `Notification` shown in its place is delivered from a backgrounded Android WebView. With the pass
   itself down to one round trip, the trade stopped being worth its risk.

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

- the stream now carries silent frames, so anything reading it to *notify* would have to tell them
  apart. The one such reader (DF2, the replay at activation) was deleted on 2026-09-28, and the
  per-entry `silent` field with it ([channel-encryption section 20](channel-encryption.md));
- the client's replay handlers for mutations, dead until now because no mutation reached the
  stream, become the path every mutation takes on replay. See D7.

### Also measured that day

- solicitation fired at **+3 s**, while the device's own inbound drain was still running - a
  difference it was itself in the middle of closing. **FIXED**: the ask now waits on
  `waitForMessageQueueIdle()` rather than on a delay, so it compares a settled store by construction
  and not by luck;
- the rendered list froze for ~10 minutes after a large bundle ingest. Nothing was lost - all four
  probe markers were present after a reload - but nothing appeared on screen either. **FIXED**, and
  the cause was arithmetic rather than anything to do with history: `batchAddMessages` asked
  `convo.messages.find(...)` twice per incoming message - once to decide whether to upgrade it, once
  inside `resolveMessageTimestamp` - so ingesting `m` messages into a conversation of `n` cost
  `2·n·m` comparisons on the main thread. A bundle of a thousand into a store of eight thousand is
  sixteen million, which is the ten minutes. Both now read one index built once per batch
  (`indexMessagesById`), and `resolveMessageTimestamp` takes a LOOKUP rather than a list so no call
  site can quietly reintroduce the scan. The cost is now proportional to the batch and not to the
  conversation, which is what "any size" requires.

---

## The model

### Two boundaries, not one

**The conversation floor** - shared, monotone, travels inside the exchange.
: *"The history of this conversation begins here."* Below it nobody claims and nobody answers. It
  only moves forward; when two devices disagree the **larger wins** (a `max`, so it merges without
  coordination). It is what makes pruning safe.
: **Hard constraint:** it may never sit below what some member can still supply, or the system
  promises a completeness nobody can honour.
: **SHIPPED, worth zero.** `Conversation.historyFloor` / `ConversationMeta.historyFloor` (SQLite
  schema v7), merged by `mergeHistoryFloor` wherever a bundle lands - live and on replay - and
  restated on every `history_bundle` chunk, since a `max` is free to repeat. Nothing moves it: it is
  present so that the day something does, the field is already converged across the fleet. A floor
  claimed in the FUTURE is clamped to now at the parse boundary, for the same reason
  `parseReadWatermarks` exists - a `max` merge has no way to take a bad value back, and a floor
  above the messages would hide the conversation on every device that merged it.

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
: **SHIPPED, and now a bound.** `$lib/utils/chat/historyWindow.ts` holds the two constants, the
  platform split (`isTauriRuntime`, the only distinction that matters here - mobile and desktop
  answer the same) and `historyRangeStart(floor, now)`, the later of the floor and the window.
  `history_digest` and `history_pull` both state their `since`; the rendezvous carries the digest's
  through to the responder as one `SolicitedDigest`, because a digest without its window can only be
  answered in full - the behaviour the window exists to end.
: **`since` is STATED, never recomputed by the answering side.** The window slides, so two devices
  computing `now - 90 days` a second apart get two different boundaries - and a boundary that
  disagrees by a second is a message neither side believes it owes. The asker states it; the
  answerer obeys it; one exchange uses one number.
: **The digest says what a device HAS; `since` says what it WANTS**, and the two sets differ. The
  digest is deliberately not clipped: a device holding messages below its own window can still serve
  them to a peer whose window reaches further back, and it can only do so by describing them.
: **The clip is applied to the ANSWER, never to the COMPARISON**, in `sendHistoryBundleForIds` - the
  one place holding both the messages and their timestamps, since an id list carries no dates. This
  is not an implementation convenience: a stored timestamp can differ by a hair between two devices
  (the reason the manifest buckets the ID space and not time), so clipping the comparison would let
  a message near the boundary read as missing on one side and present on the other, permanently.
  Clipping the answer cannot - the worst it does is decline to send what was not asked for.
: **Each leg states its OWN window.** `handleHistoryRequest` plays both roles in one exchange: it
  answers within the requester's `since`, and the pull it sends back states its own. Reusing the
  requester's there would cap every device in the conversation at the shortest window in it.
: **An emptiness produced by the clip still VOUCHES.** Completeness was defined by the asker's own
  line, so "everything you lack is below it" and "you lack nothing" are the same answer; withholding
  the vouch would leave a device that is complete for its window re-soliciting for ever.
: **A bundle nobody asked for is not clipped**, and that is deliberate: `sendFullHistoryBundle` is
  pushed to a device being INVITED, which has stated no window because it has not asked anything.
  Over-delivering there costs the receiver disk and nothing else - and under-delivering would lose
  messages the joiner has no other way to obtain. It is bounded by the sender's own window anyway.

  **What is actually enforced today (verified 2026-10-22): 90 days on EVERY platform.** The window
  above is what a device CLAIMS (`historyWindow.ts:39-47`, `deviceWindowMs()`), but the only local
  deletion is the garbage collector in `ChatBackgroundService.svelte:1789-1802`, which calls
  `deleteOldMessages(90 days)` every 6 hours with no platform check, on IndexedDB
  (`db/indexeddb.ts:924`) and on SQLite (`db/sqlite.ts:773`) alike. So a native device prunes at 90
  days while claiming 5 years - an open decision, in [backlog](../backlog.md) (P2, local retention).

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

> **The seams these map to already exist, and one of them is a clock that must go.**
> `openGatewayConnection` connects and calls `fetchPendingMessages`, which pages the mailbox and then
> `await`s `waitForMessageQueueIdle()` - a real completion signal, not a delay, so step 3 needs
> nothing invented. `syncConnectionAfterWsOpen` is step 2. It ends with
> `await new Promise((r) => setTimeout(r, 500))` described as *"small delay to let the first batch of
> messages arrive"*, and **that sleep is what step 4 must replace**: a comparison placed after a
> guessed delay reports differences the device was still closing, and reports them differently on a
> fast network than a slow one. `waitForMessageQueueIdle` is the honest bound and is already
> available on `IMlsService`.
4. **Then, silently, in the background:** send the elected online peer a compact **state key** for
   the requester's window and ask whether it matches.

> **STEP 3 BINDS EVERY TRIGGER AND BOTH SIDES, which is not how it was first built** (corrected
> 2026-08-13). The order above was honoured only by the connection path, because that is where the
> ordering lived - `initializeConnection`, step 5, after its own `waitForMessageQueueIdle`. The three
> reactive triggers fire from wherever they are raised, and two of them are raised *inside the drain*,
> so they computed a state key over a store still being written. Measured on production the same day,
> on a browser and on the phone: `[HISTORY_STATE] Sent` and `[HISTORY_RECONCILE] asked` both landed
> between a `Drain start` and its `Drain complete`, while the connection path - which does wait - had
> nothing to ask for at all.
>
> **And it binds the ANSWER as much as the ask.** A device describing its store mid-drain is not a
> reliable source: it can answer *same state* while the frames that would change that answer are
> still queued, or serve a bundle short of exactly what it was about to apply. Either outcome ends
> the exchange with the two devices still apart, and the asker has spent its coalescing window on it.
>
> Two shapes hold it together, and both are load-bearing. The barrier sits in `reconcileGroup` - the
> one door every trigger passes through - **after** the coalescing reservation, so a burst of forty
> failing frames parks one waiter and not forty. On the answering side it is `answerAfterMailboxDrained`,
> which **defers rather than awaits**: every responder leg runs inside the message pipeline, so
> awaiting the queue from there is the drain waiting on itself. The frame is acknowledged once the
> answer is scheduled - a real weakening, accepted because nothing in this exchange is durable by
> design and the asker re-asks on its next edge.

> **Step 3 orders the two paths at the START of a walk. It says nothing about the middle of one, and
> that is a second overlap** (closed 2026-08-14). The archive holds every frame, *including the ones
> still queued for live delivery*. So a replay whose upper bound is "the stream tail whenever I get
> there" necessarily walks rows written while it was walking - precisely the rows the queue is about
> to hand over - and both paths present the same ciphertext to MLS again. The barrier cannot reach
> them: they did not exist when it was crossed. On a conversation large enough to page, that window
> is the whole duration of the walk, which is exactly the size the standing directive rules out.
>
> **The bound is the stream head observed at the walk's first page.** `GET /api/mls/history/:groupId`
> reports it in `X-History-Head` (`heads` on the batch route), the client passes it back as `until`,
> and the server uses it as the `XRANGE` end instead of `+`. At or below the head belongs to the
> replay; above it belongs to the queue; the split is structural rather than reconciled afterwards.
> The rows above are never read at all - no bytes on the wire, no decrypt, and no ledger entry.
>
> **Why stopping early is safe:** the cursor only ever advances over rows actually walked, in stream
> order, so a walk that stops at the head leaves the cursor at the head and the next one resumes
> there. It is the same property that makes `advancePast` a walk and not a jump.
>
> **What this does NOT close, and the honest width of it.** The seam is now one round trip wide
> instead of one walk: a frame written between the drain going idle and the head being read is below
> the head and not yet in the ledger. Two structures are involved - the per-device queue and the
> shared stream - written at different moments by the server, so no client-side ordering can make
> that zero. The shared-fingerprint ledger still covers it, which is what it was written for; what
> changed is that it is no longer the mechanism that makes ordinary traffic work.
>
> The head was expected to have a second use - a **stable, shared upper bound** to give the fourth
> trigger the terminator it lacked. **It was the right principle at the wrong end**, and saying so is
> worth more than deleting it: "I walked to H" is a fact both sides can compare against, where "I
> think something is missing near the end" cannot terminate without a clock. But the shortness the
> fourth trigger measures is at the BOTTOM, not the top - the two sides already agree on the top,
> because step 3 drains both mailboxes before either compares anything. What the answer had to state
> was where the ANSWERER's memory begins. See [the fourth trigger](#the-fourth-trigger-an-answer-that-does-not-reach-far-enough-back).

The state key covers **the id set and the mutation state** - not ids alone. Two devices agreeing on
which messages exist can still disagree on which are deleted, and both would call themselves
complete. Ids and mutation state only, never content: a deleted message keeps its id and changes its
content, and the two devices must still recognise their agreement.

It is **cached per conversation and invalidated on write**, never recomputed by walking the window.
Connect cost must not grow with retention, or the 5-year window would be paid on every connect for
a comparison that almost always matches.

**SHIPPED as the rule, not yet as the exchange.** `$lib/utils/chat/historyStateKey.ts` computes it:
a canonical string per message - id, deleted, the edit's own `editedAt`, and every reaction pair
with its instant and whether it stands - SHA-256'd and XOR-folded into 64 bits. Four properties are
load-bearing and each is pinned by a test:

- **the fold is XOR**, so the key cannot depend on the order a store is walked in, and in particular
  not on a sort two devices might do differently (the mistake `compareIds` exists to prevent);
- **XOR is not idempotent**, so a duplicated id would cancel its own message out of the key - the
  walk deduplicates by id before folding, and that guard is not tidiness;
- **content is excluded**, or a purged deletion would look like a difference for ever between two
  devices that agree completely - and so are the sender and the timestamp, which no exchange
  repairs;
- **read state, the floor and the pin register are excluded**, deliberately. All three ride on every
  bundle and converge through the shared log the reconciliation drains BEFORE comparing. Including
  them would let the most frequently changing thing in a conversation trigger a digest exchange that
  repairs messages nobody was missing.

**The boundary had to be quantised for the key to be comparable at all.** A key is computed over
`[since, now]`, and an unrounded `since` slides continuously: two devices deriving it a second apart
compute over two different ranges, so the fast path could never fire and a cache keyed by that value
could never hit. `deviceWindowStart` now rounds DOWN to the day, so every device connecting on the
same day asks from the same instant. Either side of midnight they disagree and exchange a digest,
which is what the digest is for.

**The cache is SHIPPED** (`cachedHistoryStateKey`), and what it protects against is the WALK:
computing a key reads and decrypts the whole window, which on a 5-year store is the same order of
work as the post-ingest freeze this rework removes. It is keyed by `(conversation, since)` - a key
computed over a wider range is not an answer about a narrower one - and a failed read is never
cached, because a failure is not an empty store and caching it would tell every peer this device
holds nothing.

**The invalidation lives at the storage layer, not at the call sites**, and is conservative by
construction: a stale key claiming agreement loses messages silently, while an over-eager
invalidation costs one walk. Every `IStorage` method that writes message rows drops the entry -
per conversation where it can name one, wholesale where it cannot (`deleteOldMessages`, `clear`).
Both backends are separate classes with separate write sites, so "IndexedDB was updated and SQLite
was not" is the shape the mistake takes; `historyStateKeyInvalidation.test.ts` reads both sources to
keep it from being made, and carries a vacuity guard so it cannot quietly stop checking.

- **Keys match** → nothing is sent, nothing is displayed. The common case, and it must cost one small
  frame.
- **Keys differ** → then, and only then, exchange the hierarchical digest that already exists
  (`groupActions.ts`, `sendHistoryDigest`), and each side sends what the other lacks **within that
  side's window**. That last clause is **SHIPPED**: every ask carries a `since` and every answer is
  clipped to the one it was given - see [the device window](#two-boundaries-not-one).

Election is unchanged: the server picks one online member, so the exchange stays two-party. A
broadcast digest would cost every member a decryption for a repair concerning two devices.

**And the key must ride that same election, for a reason the digest only half had.** A digest costs
every member who receives it a decryption; a state key costs each of them the WALK behind computing
their own to compare against, which is the expensive half of this whole mechanism. So the key is not
broadcast to be answered by whoever feels like it: the requester elects a responder exactly as it
does today (`sendHistoryRequest` over the WebSocket) and puts the key inside MLS, and only the
elected device compares. The rendezvous that already joins those two transports
(`historyDigestRendezvous`) is the same shape and should carry the key rather than gain a twin.

**SHIPPED, and the rendezvous carries all three asks rather than gaining a twin.** A probe names its
KIND - `state`, `digest` or `range` - and all three carry a `since`, because all three are asks and
an answer is clipped to the window it was given. Silence is the fast path: when the keys match
nothing is sent at all, which is why `vouched` and the three-way `EmptyBundleMeaning` could be
deleted outright rather than kept for the agreeing case.

The resulting flow, which is today's with one probe in front of it:

| | today | with the key |
| --- | --- | --- |
| stores agree | digest → diff → empty vouched bundle | key → empty vouched bundle |
| stores differ | digest → diff → bundle | key → *"send me your digest"* → digest → diff → bundle |

One round trip is added to the case that differs and one whole digest is removed from the case that
does not - which is the common one, and the only one paid on every connect of every device.

### Two groups are refused before anything leaves, and both are answered locally

`reconcileGroup` is the one door every trigger comes through, so the two exclusions that are
permanent live there rather than in each caller's candidate list.

| refused | why | said aloud |
| --- | --- | --- |
| a **distribution group** | it carries channel seeds and has never held a message, so there is no history to reconcile - and it must never reach the conversation pipeline, which this is the repair arm of | **no** - not asking is correct and permanent, and there is nothing for a reader to act on |
| a group this device **holds no leaf in** | the probe is an MLS frame, and a device with no leaf mints frames no member can open | **yes** - it explains the absent probe, and the group returns when a Welcome installs a leaf |

**THE SECOND ONE WAS LEARNED BY BEING REFUSED UNTIL 2026-09-24.** Measured on DEL-1, 2026-09-05:
seconds after a peer re-added a device to a group it had been evicted from, and before the Welcome
had been processed, the connection audit picked that group up, broadcast a `history_state` probe,
and got `403 sender_not_active` back - logged as `[HISTORY_STATE] Send failed`, which reads like a
delivery defect to whoever meets it. **The group is in `getLocalGroups()` legitimately**: an
eviction leaves the state in the WASM store as an INACTIVE group, which is the same fact
`setupMessageHandler` relies on to tell a re-admitting Welcome from a redelivery.

Nothing was lost - `sendHistoryStateKey` returns `false`, and its contract says the caller treats
that as *"this group was not reconciled"*, never as *"we agree"*, so the sweep simply happened
later. The server was right to refuse, for the reason `SenderNotActiveError` was typed after
production turned six messages into thirty unopenable rows on 2026-09-02. **What was wrong is the
ASKING**, and it is the rule this repository states as *never learn by failing what a fact could
have told you*: `isGroupActive` answers it here, from the local store, with no network at all.

**A THROW IS NOT A `false`.** `isGroupActive` throws for two causes it does not separate - the WASM
client is not loaded, and the group is not held at all - and reading either as *"we were removed"*
would silence reconciliation for a device whose store simply could not be read. Both mean the local
store cannot answer, and asking the network what the local store cannot answer is exactly right, so
the pass proceeds and logs that it could not read its own membership.

### The fifth trigger: an ask that reached a member which answered nothing

**The election is random on purpose, and the client owed it a second draw.** `notifyHistoryRequest`
shuffles the members before forwarding, and the comment says why: *"A backgrounded Android holds its
WebSocket TCP open, so `user:online` can be true while the app cannot process the frame
(frozen-online). The requester re-solicits on a bounded backoff; randomizing the responder each call
lets those retries rotate past a frozen peer to a genuinely reachable one."* **The requester did not
re-solicit.** `reconcileGroup` asks once and the coalescing window swallows everything for 30 s.

Measured 2026-09-05 with the server's log beside both clients, on HEAL-REVOKE-7 `--order last`:

| when | what the SERVER did | what followed |
| --- | --- | --- |
| 22:41:50 | `FORWARDED target=<the phone>` for the returning device | silence |
| 22:41:56 | - | the returning device holds 4 frames it cannot read; swallowed, 6 s into 30 |
| 22:43:15 | `FORWARDED target=<the phone>` for a reference device | silence |
| 22:43:20 | `FORWARDED target=<W1>` for the same reference device | `3 of 3 requested message(s)` |

**The reference device is whole because it asked twice**; it asks twice because a fresh enrolment
joins each group, which clears the coalescing note. The returning device re-joined into a group it
already held (`already in WASM - skip`), kept the note, and stayed three messages short for ever.

**So a trigger that can PROVE incompleteness escalates rather than defers.** A frame this device
holds and cannot read is proof of a gap without asking anybody, which means silence from a responder
has told it nothing - where for every other trigger silence genuinely means *we agree*.
`escalateReconciliation` adds the member the in-flight ask reached to an excluded set and elects
again. It terminates on the proof the server already delivers - `no_peer_online` with a positive
`excludedOnline`, *every reachable member has been asked* - which is the coverage walk's proof
reused rather than a new one. One member per step, the set only grows, and forty unreadable frames on
a group with two online members cost two elections and then a fact.

**AND THE BARRIER THAT MADE IT SLOW IS SCOPED NOW.** `answerAfterMailboxDrained` waited on the
WHOLE mailbox: idle only once the device had applied everything, which on a device rejoining
twenty-nine conversations was **189 seconds** between the question and the answer. The reason the
barrier exists is a claim about the frames of THE GROUP BEING DESCRIBED, so it takes the group it is
answering about and waits for that one - `waitUntilGroupIdle`, woken after every frame rather than at
the end of a drain. Three details carry it: a picked frame is out of its bucket and not yet applied,
so the drain records which group it is inside; the untagged bucket is waited for too, because
nothing in the scheduler can say whose an untagged frame is; and a handler that throws still clears
the marker.

**AND THE EXCLUSION IT WALKS ON HAD NEVER WORKED.** The first run of the escalation asked the
server nine times to skip the sleeping phone and was handed it back every time. The server filtered
the exclusion list with `k.length <= 128`, and a member key - `userId:deviceId`, a 64-character hex
digest plus a device id that repeats it - is **147 characters for a browser and 149 for the phone**.
Every key was dropped in silence. So the fourth trigger's termination argument, *each step of the
walk removes exactly one member*, had been inert since it shipped: the walk removed nobody, and the
client's guard against a server that ignores an exclusion stopped it instead. Fixed with a cap
measured against a real key, a warning when an exclusion cannot be used, and a test whose fixture is
the shape this platform issues rather than `ua:da`.

**What is still open is that SILENCE CARRIES TWO MEANINGS.** *We agree* and *nobody answered* are the
same observation, which is why the escalation has to be gated on local evidence instead of on the
absence of a reply. Making the agreeing responder ack would cost one frame per group per ask - the
saving the state key exists for - so it is a design question, not an oversight
([backlog](../backlog.md)).

### The second leg does not need a live waiter, and requiring one cost three messages for ever

**Measured on the local estate 2026-09-05, by HEAL-REVOKE-5 and then isolated by HEAL-REVOKE-7's
order pair.** The responder asks *"describe yourself"* and waits `DIGEST_TTL_MS` = 60 s for the
digest. The asker answers only once its own inbound queue has drained - deliberately, because a
digest computed mid-drain describes a store still being completed. **A device that has just rejoined
an account is applying every group's external join at once**: it took 67 s, and its digest reached a
responder that had stopped listening seven seconds earlier.

| when | who | what |
| --- | --- | --- |
| 22:11:09 | the returning device | external join, state key sent, `asked ... whether we hold the same history` |
| 22:11:09 | the responder | `Keys differ - asked <it> to describe` |
| 22:11:15 | the returning device | `holds 4 frame(s) it can never read - reconciling` - **and no ask leaves**: `recentlyAsked`, 6 s into a 30 s window |
| 22:12:09 | the responder | `asked ... to describe itself, no digest came` |
| 22:12:17 | the returning device | its digest goes out - **eight seconds too late** |

**The order pair is the control.** Run the same row with nobody online at the moment of the return
and the first ask is answered by no one, so the frame trigger fires 42 s later, OUTSIDE the
coalescing window, produces a real second ask, and the exchange completes in two seconds: 3 of 3
messages. The run that HAD a responder available immediately is the one that loses them.

**The repair is that the last leg needs nothing remembered.** The digest carries the manifest and
the window the asker drew; our store carries the rest. So `answerHistoryDigest` is a function, not a
continuation inside the wait, and `systemMessageHandler` calls it when a digest arrives for a
solicitation this device issued and no waiter took. `takeDigestSolicitation` keeps that addressed -
the leg is a group broadcast, every member records it, and only the device that ASKED holds an
outstanding solicitation - so the election still elects exactly one responder. The 60 s now bounds
MEMORY, which is what a TTL is for, instead of bounding CORRECTNESS.

**Two things follow that are worth stating separately.** A wait is not a termination proof: raising
the 60 s buys the next slower boot nothing, and shortening the coalescing window is the same mistake
twice. And a trigger swallowed by coalescing is promised that the ask in flight covers it - the
window's own justification says *"the next connection re-asks unconditionally either way"*, which is
false for a session that stays up - so the swallow is now LOGGED rather than silent, because
`history.ts` announces *reconciling* before calling and a silent decline made that line a claim
about something that did not happen.

### A digest overheard is evidence: the member that lacks something asks its author (2026-10-13)

**Measured on production 2026-10-13, group `656597dc`.** A user's phone (`<device-a>`) came back
after ~100 minutes away, asked, and the server elected the same user's other phone (`<device-b>`):
`history_state`, `history_digest_request`, `history_digest` (7 ids), `history_pull`. The user's
browser (`muh72dix`) is a member, so it received all four legs. It held 6 rows, logged
`[HISTORY_DIGEST] From ... 7 id(s)`, then logged nothing and sent nothing. The message the phone
showed never reached the browser.

**Every one of the browser's own triggers was right to stay quiet.** No unreadable frame was held,
the server had no queued row left for it (the send logs show every frame of the group either
`PUBLISHED` to it or read by its stream walk, whose cursor reached the stream head), and the
connection pass logged `no sweep - away 0 d ... every group already audited`. The gap had no local
witness. Its one piece of evidence was a digest addressed to somebody else, and the
`history_digest` branch dropped a digest it had not solicited, without a line. The responder could
not repair the browser either: `mv6mmuu1` joined by external commit at 11:58 and got its past as
bundles from the browser itself, so it lacked the same id. Its own pull to the phone at 13:11:03 hit
`TRANSPORT_SKIPPED_OFFLINE`: the phone had gone to the background seven seconds after its digest.

**The rule now.** `pullFromOverheardDigest` (`historyDiffAnswer.ts`) handles a digest that no waiter
took and no solicitation claims. After its own mailbox for that group drains, the device diffs the
digest against its store and sends an addressed `history_pull` to the AUTHOR for what it lacks,
stating its OWN `since`. It never answers on the author's behalf: what the author lacks is the elected
responder's job. Both roads go through one `pullWhatWeLack`, so the elected responder and the
overhearing member cannot drift into two pulls. This is the bundle rule ("an answer meant for a peer is
simply free messages") applied to the question:

| | cost | why it is acceptable |
| --- | --- | --- |
| store read per overheard digest | one walk per member device | a digest goes out only after two state keys DIFFER, so it is the exception |
| pull | one addressed frame, only when the diff is non-empty | the author answers with a bundle, and a bundle asks for nothing |
| ids below our window | the author clips them (`Held N ... below the asker's window`) | the same cost the elected responder already pays: an id list carries no dates |
| a `range` digest | **not pulled**, one line (`overheard ...'s range digest ... not pulled`) | a slice names a difference, never who is short, and its answer is the author's whole slice broadcast to the group. Every overhearing member would draw it, and a browser's 90 days differ from a phone's five years in nearly every slice. The elected responder still settles it, once |
| an `ids` digest above `DIGEST_ID_MODE_MAX` | **not pulled**, one line | no client builds one (it switches to `range`), so only a forged frame carries it; read as is, one frame from one co-member would make every member send up to ten pulls |

**The bound, by construction and with no clock in it** (adversarial review, 2026-10-13): one
overheard digest costs each device at most one store read and `ceil(1000 / 500)` = 2 pull frames
naming exact ids, and the author answers only ids it holds inside the puller's window. A pull is
answered by a bundle and a bundle asks for nothing, so no leg re-enters the exchange. What is NOT
bounded below the group size: with N devices lacking the same id, the author serves it N times (each
bundle is also ingested by everyone else, deduped by id). That is the price of asking without a
second election, and it is paid only when a digest exposes a real gap.

Every outcome is logged, as `overheard ...'s digest naming N id(s) we lack - asked it for
them` and `... we hold everything it lists`. The silence is what made this one take a console export
to find.

**What this does NOT close, stated so nobody believes it closed.**

- **A pull to an author that has already left gets ONE more chance, not a guarantee.** A pull is a
  transport frame, so the server drops it for an offline author and never says so (that race stopped
  `mv6mmuu1`'s pull here). `historyOverheardPull.ts` keeps, per conversation and author, the LATEST
  digest that made this device ask (a newer one replaces it; one that leaves nothing to ask drops it),
  and spends it ONCE on the next frame from that author that arrives LIVE (`deliveryMeta.channel`,
  stamped by `enqueueMessage` after the dedup) with its device checked by `verifiedSender`, in any
  conversation. The author's own `history_digest` does not spend it: it supersedes it. The retry
  waits for that conversation's mailbox and diffs the same digest against the store as it is NOW, so
  whatever the first ask brought is not asked again. It records nothing, so there is no third ask:
  ids below our window (which the author answers with silence) cost two pulls, never a loop. No clock:
  an author that never comes back costs one map entry and no traffic. The memory is session-bound:
  emptied by `resetHistoryReconciliation` (sign-out, account switch), forgotten per conversation by
  `forgetGroupReconciliation`, and a ticket taken when the digest arrived stops a pull still in
  flight from recording across either. **What still escapes it**: a reload in between, an author
  that sends us no live frame in this session, and an author gone again before the retry lands.
- **A conversation above 1 000 messages is not covered.** Its digests are `range`, which the
  overhearing road declines (table above), so the same gap in a large conversation stays as silent as
  before - now with a line saying the digest was seen and not pulled.
- **HOW the browser lost the message is NOT established.** Every frame of the group in the server
  stream (`history:{gid}`, 19 entries) reached the browser by queue or stream walk, and the server
  logs cannot tell which id the phone holds that the browser lacks (ids are inside the ciphertext).
  It is consistent with a frame decrypted once and then not stored (the queue/stream double
  presentation, [WP-DUPDELIVERY-1](#wp-dupdelivery-1---the-ledger-was-the-witness-and-the-overlap-was-one-await-wide)),
  but that is inferred. **To confirm it:** compare the phone's 7 ids with the browser's 6. The odd id's
  timestamp places it among the stream entries, and that entry's `send-*` trace names the delivery
  path the browser took.

### A device that holds nothing opens with its digest, not its state key (2026-10-14)

`sendHistoryProbe` (`utils/chat/groupActions.ts`) is the first leg, and it picks one of two frames.
If this device's store holds **zero** rows for the group (`countMessages`), it sends its digest
straight away. Otherwise it sends the state key, as before.

**Why.** An empty store's state key can only get two answers. An equally empty peer stays silent.
Every other peer answers `history_digest_request`, and this device then sends the digest it could
have sent at once. The responder already answers a digest probe directly (`handleHistoryRequest`,
since `v0.14.0`), so the exchange becomes one round trip instead of two. An empty digest is as small
as a key.

That empty shape is the after-sign-in case: the device rejoins every group with nothing stored. On
the Mi 9T on 2026-10-13, each extra leg arrived as its own drain, and each drain triggered its own
full checkpoint: about 4 checkpoints per rejoined group, 247 in 432 s
([community-open finding 2](../frontend/community-open-slowness-mi9t-2026-10-13.md#finding-2---after-a-sign-in-the-checkpoint-runs-93--of-the-time-and-each-one-costs-more)).
Removing that leg removes one inbound frame and one outbound frame per rejoin. Of the two drains it
would have cost, one is gone.

**What a member does when it overhears an empty digest.** It returns at once, silently, without
reading its store: the `[HISTORY_DIGEST] From ... 0 id(s)` line written on arrival already says it. An empty list names nothing
the member could lack. Every member overhears that frame once per rejoined group.

**What stays.** A store holding anything keeps the state key. There, agreement is the likely
outcome, and a key costs one frame where a digest costs a walk on both sides. A count that cannot be
read is treated as unknown, never as empty, so it also falls back to the state key, and the failure
is logged. Pinned by `groupActions.historyProbe.test.ts` and `historyDiffAnswer.overheard.test.ts`.

### The fourth trigger: an answer that does not reach far enough back

**SHIPPED 2026-08-16.** The other three triggers are things a device notices about ITSELF - a
connection, a fresh join, a frame it could not decrypt. This one is raised by an ANSWER, and it
exists because of the deliberate inequality above: a phone keeping five years asking a browser
keeping ninety days gets a clipped answer **every single time, by construction and not by fault**.

The phone could not tell that apart from *"this conversation has no more past"*. Both look like an
absence, and an absence is not evidence of anything. So it either believed itself complete - losing
years silently - or re-asked, and a re-ask on that evidence never terminates: the same peer is
elected, gives the same clipped answer, and only a counter or a clock could ever stop it.

**Two facts replace both, and neither is a duration.**

**1. The answer STATES where the answerer's memory begins.** `history_coverage` carries
`coveredFrom` - the answerer's own `max(floor, deviceWindowStart)` - and is sent **only when that is
later than the `since` it was asked for**. Silence therefore keeps meaning *"I cover what you asked"*,
so two devices of the same platform still exchange exactly one frame. It is sent **last**, after any
bundle, because MLS orders one sender's frames: arriving last is what makes it read as *"that is
all, and I am complete only from here"*.

It is stated rather than discovered because the answerer already knows it. Handing a peer an
operation certain to come back short, in order to classify the shortness, is the work the design
owes - the discriminator travels from where it is known.

**And it is sent even when the two state keys MATCH**, which is the case nothing else would have
caught: two devices can hold exactly the same messages over the asker's window and both be missing
the years below the answerer's. The key is computed from what each store holds, so it agrees
happily. **Agreement is not completeness.**

**2. The next election EXCLUDES every member that has stated one.** `POST /api/mls/history-request`
takes `exclude` - member keys already heard from - and each step of the walk therefore removes
exactly one member from the reachable set. The set is finite and only shrinks, so the walk visits
each member at most once.

**The termination proof is delivered, not inferred.** The server answers `no_peer_online` with
`excludedOnline`, a COUNT of the members that were online and skipped only because we had already
heard from them. A positive count means *every reachable member has answered you* - the proof - and
the walk ends. Zero means *nobody was there*, which is a different fact answered by a different edge
(the peer-online retry). One status, two facts, separated by evidence rather than by prose.

Three properties keep it honest:

- **the claims are facts, not chase state.** A retention window only slides FORWARD, so a member
  that says "I am complete from ninety days ago" can never later cover more of the past. The claim
  is sound for the whole session, and nothing has to decide when a walk is "open" or "closed";
- **an ordinary reconciliation never carries an exclusion.** Those claims are about COVERAGE; an
  ordinary comparison is about CONTENT, and a member with a short memory still receives every new
  message. Excluding it there would skip a real repair;
- **a server that ignores `exclude` stops the walk, loudly.** Mid-rollout an older build re-elects
  the member we asked it to skip, and a step that re-draws a member already in the set advances
  nothing - the one shape that would not terminate. The client compares the elected `target` against
  its own exclusion list and stops with a line that accuses.

Nothing here is scheduled and nothing is retried. Being wrong about any of it costs elections, never
a message. When the walk ends without closing the gap, the gap is simply not remembered: the next
connection compares again from scratch, which is where a member with a longer memory gets its turn.

### What that leaves open, and why it is left open (decided 2026-08-17)

Two consequences follow from having no schedule, and both are accepted rather than overlooked:
**a device that never connects is never repaired**, and **one whose peers are never online at the
same moment waits for the first that is.** Neither is a defect to be fixed by a periodic
solicitation - a broadcast on a timer is the exact mechanism this rework deleted (see the list of
what was removed), and it repaired nothing while costing ~450 frames a minute.

**And `history_request` is deliberately NOT durable the way `welcome_request` is.** The asymmetry is
not an oversight, and it rests on three facts:

- a stored request drained hours later has **no probe left to answer it** - the digest rendezvous
  has a 60 s TTL, so what is replayed is an ask nobody is listening for;
- the requester **must reconnect to read anything anyway**, and reconnecting compares from scratch,
  which asks again by itself. A durable copy would only duplicate the trigger that already exists;
- the two failures are not the same size: **a missing Welcome BLOCKS a group outright, a missing
  history only degrades one.** Durability is worth its discharge condition for the first and not for
  the second - and the discharge condition is precisely what could not be met the last time this
  area carried a durable registry.

### A new member receives nothing from before their arrival (decided by the user, 2026-10-21)

**The decision**, for private GROUP conversations, as on WhatsApp and Signal: a member added to a
group reads only what was sent after they arrived. **It reverses what the code does, which nobody had
decided.** `sendFullHistoryBundle`, pushed by the adding device from `processPendingInvitations` and
`handleWelcomeRequest`, sends that device's whole local store to the invitee, up to the 5-year
window. The section below calls this *"the existing new-member policy"*, but no decision record
exists for it. On 2026-10-21, 6 of the 15 live group conversations had admitted 24 members more than
10 minutes after their creation (read-only count on production). Communities keep their own recorded
decision (`shared`), and 1:1 conversations have no add path.

**One rule covers both decisions.** A device may receive a message only if its server time falls
inside one of its USER's membership intervals (`dm_group_membership_intervals`, one row per stretch of
membership, not per message or per epoch). A newcomer has one interval starting at arrival. A member
removed and re-added has two, and the gap between them is the 2026-10-14 rule. A new device of a
continuous member is covered by an interval reaching back to that member's own arrival, so it still
restores everything.

**Why it cannot be added to the union.** The filter of the next section withholds the UNION of
every member's gaps, because a bundle is an MLS broadcast every member ingests. Treating "before
first arrival" as a gap in that union would withhold everything older than the newest member's
arrival, from everybody, and so break the restore of every new device. The span is therefore applied
for ONE person, only where that person is known. Two steps, in this order (Master's verdict,
2026-10-22):

**Step C - BUILT: the inviter's push withholds the INVITEE's span.**

- chat-delivery's exclusions route answers a second field, `withheld`
  (`withheldWindows`, `utils/group-membership.ts`): a person's gaps plus everything before their
  first arrival. It names the CALLER and the one person asked `for` (`?for=userId`), nobody else, and
  each of them gets an entry when the server counts them, an empty one included. **A missing entry
  is therefore a refusal, never an empty set**: the push sends nothing and the receiver ingests
  nothing on it. `exclusions` keeps its old meaning, the union a broadcast answer is filtered on.
- **A server that predates `withheld`** (a store build runs ahead of production) answers without the
  field. That fails the `withheld` read alone, as `WithheldUnsupportedError`. The push and the
  receiver then keep their old rule, the union of gaps and the device's own gaps: a newcomer is still
  pushed the past in that window, and the push says so once per session at error
  ([legacy-compatibility](../legacy-compatibility.md)).
- **`for` answers only for a person with a device added since the caller arrived** (a device row in
  the group created at or after the start of the caller's CURRENT interval, its recorded admission
  when earlier; `for` compared case-insensitively): a newcomer, or a new device of a member of any
  age. The caller witnessed that add. For any other member it has no entry, so a member cannot read
  the arrival of somebody whose devices all predate their own. **The current interval, not the first
  arrival** (review of #2226): measured from the first, a member who left and came back could read
  the arrival of a person added while they were out. One consequence is the rule's own and stays: a
  member who adds a device makes their arrival readable to members who came later, since that add
  is one they witnessed. Each answer is a time, never a message.
  **It was a row STATUS first (`pending`), and that starved the push it exists for**: the invitee
  promotes its row to `active` as soon as it processes its Welcome, while the push may still be
  re-reading its windows chunk by chunk, so the entry vanished mid-push and the push stopped.
- **Group conversations only, never a 1:1.** Nobody is added to a 1:1, and its recorded arrivals are
  not arrivals: on production 2026-10-21, 51 of 472 1:1 members had a first interval starting more
  than 10 minutes after the conversation was created. Applying the span there would take a member's
  own past away from their next device. Key groups are read as 1:1s; nothing here reaches them.
- **The first arrival is the earlier of the first interval and the person's first device row in the
  group. This is a DECISION, not a proof: added = arrived** (as on WhatsApp). A device row is written
  when a commit admits the device, and it can wait there for an invitee who is offline, so an invitee
  is handed what was sent between the invitation and their first connection. Those frames were queued
  to them live anyway. Measured on the control population, the 6 live group conversations with a late
  joiner (2026-10-21, read-only): the 105 founding members' first intervals all match their first
  device rows, but 4 of the 24 late joiners held a device row up to 268 hours before their first
  interval. The likeliest reading is an offline invitee whose admitted row waited. Without the device
  row, their next device would have lost those 268 hours.
- **The arrival survives a revoked device (migration `033`, review of #2226).** A device row is not
  durable: revoking the device (`purgeDeviceFootprint`) deletes its rows, and for a member enrolled
  late the first row was the only record of the real arrival, so it moved later and their next
  device lost the span. `ensureGroupMember` now copies the person's earliest device row onto the
  interval it opens, as `admittedAt`, when it is older than the enrolment. The first arrival is the
  earliest of every interval's `joinedAt` and `admittedAt` and of the device rows still present (an
  invitee admitted and not yet enrolled has only those). `admittedAt` never moves a gap: the
  2026-10-14 window still ends at the re-enrolment's `joinedAt`. **Only a row younger than the
  person's last `leftAt` counts** (review of #2254): a removal deletes the device rows and closes
  the interval in two transactions, and a `registerDevice` in between can leave a row of the
  previous membership, which would date the re-add from before the removal and reopen `for` for
  people added while they were out. **A database clock running ahead of chat-delivery's** makes a
  genuine earlier admission look no earlier than the enrolment, so nothing is recorded and the
  arrival is the enrolment: history lost, nothing handed out. The migration backfills every open
  interval from the device rows present under the same bound, which is what the reader derived from
  them already, so it changes no answer. The deploy applies it, so the release carrying it is the
  application. Two arrivals stay lost: one a purge erased before the migration ran, and one
  whose device is revoked between its admission and the enrolment. Both cost that person history
  and hand nobody anything.
- **Two clocks, bounded.** An interval is stamped by chat-delivery's process clock, and a device row
  by the database (the transaction's start; `admittedAt` is that instant, copied). The admitting transaction commits before the commit
  that lets the device read anything is fanned out, so the database instant can only be early, by at
  most one transaction. Unifying them needs a column and a migration for that bound, and was declined.
- **The person who arrived WITH the group has no span (2026-10-22).** Nothing precedes the creation,
  so `[0, creation)` is empty, but it was not harmless: an undated copy is placed against every
  window edge widened by one hour (below), so the creator dropped every undated history entry of the
  group's first hour, for good (read on the rig's GRP-7). A first arrival within
  `CREATION_ARRIVAL_BOUND_MS` (1 s, either side) of the group row's `createdAt` is the creation, and
  gets its gaps only. Measured on the local estate: the creator's interval 4 ms after the group row,
  the next member 13.5 s. A joiner's span is unchanged.
- Against a server that predates addressed answers, `sendFullHistoryBundle` still passes the invitee
  (`userIdOfLeaf(to)`) to `entitledHistorySelection`, whose filter is the union of gaps plus that one
  person's withheld windows.
- Receiver hygiene: `dropOwnExcludedMessages` reads this device's own `withheld` windows, so an honest
  newcomer drops what precedes its arrival from any bundle it overhears.

**Step A - every answer is addressed to the device that asked, and filtered for it (built
2026-10-22).** The diff, the scrollback AND the push go to `recipientDevices = [to]` and are filtered
on that reader's own `withheld` windows (`readerHistorySelection`), so an answer reaches only the device
that asked, and that device is not held to the union of everyone's gaps. The design, its six rules, what it protects against (an honest server and
an honest answerer, nothing more: addressing is a routing control and MLS still encrypts for the whole
group) and what it does not close are on
[history-answer-addressing](history-answer-addressing.md), the only copy. **Owed: the rig row
GRP-ADDR-1** ([cross-client-testing](../cross-client-testing.md)).

**What neither closes.** An older client keeps pushing and answering by broadcast until
`minClientVersion` is a release carrying A, and that floor moves only once both stores serve the
reader. The server cannot refuse such a frame, because it cannot read it. What a newcomer has already
received cannot be taken back. Tracked in [backlog](../backlog.md#p1---a-new-member-of-a-group-conversation-receives-its-whole-past-decided-2026-10-21-that-they-must-not).

### A Remove holds against a later re-add - the answering peer withholds the window (decided by the user, 2026-10-14)

**The decision** (user, 2026-10-14), for private GROUP conversations: a member removed and added
back keeps what preceded their removal and NEVER receives what was sent while they were out. It
closes [open-questions](../open-questions.md#is-a-remove-meant-to-be-durable-against-a-later-re-add).
Out of scope: communities, which keep their own recorded decision (a returner MAY read the past -
`getGraineHistoryFloors`), and 1:1 conversations, which have no remove path.

**Why the history exchange was the hole.** Live delivery already honoured a removal: the member is
out of the MLS tree. But every answer of this protocol re-sends a store as `history_bundle` frames
under the CURRENT epoch - the full bundle on an invitation (`sendFullHistoryBundle`, from
`processPendingInvitations` and `handleWelcomeRequest`), the diff (`sendHistoryBundleForIds`), the
scrollback (`sendHistoryRangeBundle`) - and none of them asked whether anybody had been out.

**The record - the server, migration `030`.** `dm_group_membership_intervals` keeps one row per
stretch of membership `(groupId, userId, joinedAt, leftAt)`. `ensureGroupMember` opens one (both
enrolment routes; at most one open row, by a partial unique index); `removeGroupMember` closes it
in the transaction that deletes the `dm_group_members` row, whose hard-delete semantics are
unchanged. The migration backfills every current member with an open interval from its
`joinedAt`. The rows go with the group (`GROUP_OWNED_TABLES`) and with the account.
`GET /api/mls/groups/:groupId/exclusions` answers `{ exclusions: { userId: [{ from, until }] } }`:
the gaps between each CURRENT member's intervals, `until: null` while still out. **The time before
a first arrival is never a gap** - that span is the `withheld` field of the section above, read per
person and never in this union - and
intervals are per USER, so a new device or a wiped one opens nothing. Only a current member may read
it - no admin bypass, no unidentified caller.

**The control - the ANSWERING client.** A requester asking politely is not a control, so every
bundle goes through `sendBundleChunks`, which passes its selection through
`entitledHistorySelection` (`historyEntitlement.ts`) before building a frame - one chokepoint, so no
answer path can forget it.

- **The union of every current member's windows, not the asker's.** A bundle is a group broadcast,
  and every member ingests answers meant for others (see the `history_bundle` handler). Withholding
  from the asker alone would hand the window to the re-admitted member reading a continuous member's
  answer.
- **What that costs a NEW DEVICE, re-quantified.** A new device - of a continuous member, or a
  genuinely new member's - restores everything EXCEPT the messages sent while a member who is in the
  group TODAY was out, plus legacy undated copies within the skew margin of such a span (below). Live
  delivery never reached that device, the server keeps no copy for a device that did not exist, and
  every answering peer withholds the span, so **for that device those messages are gone for as long
  as the re-admitted member stays**; the day they leave the group, their windows leave the union and
  the next reconciliation serves the span again. A device that already held the span keeps it - the
  filter decides what is SENT, never what is deleted. The size is exactly "messages sent during the
  absences of today's members", which nothing recorded before migration `030`, so it starts at zero
  and grows only with remove-then-re-add cycles; `SELECT count(*) FROM
  dm_group_membership_intervals WHERE "leftAt" IS NOT NULL` is the number of such spans.
- **The clock is chat-delivery's, and ONE clock.** A message is placed by `serverTimestamp`, the
  `queued_message.createdAt` its copy was delivered with. `createdAt`, `joinedAt` and `leftAt` are all
  written from the same Node `new Date()` in the chat-delivery process (`messaging.service.ts`,
  `ensureGroupMember`, `endGroupMembership`), never from Postgres's `now()` and never from a client.
  The sender-stamped `timestamp` is a client clock, read only for the legacy undated case below. A
  window includes its start and excludes its end: the re-add instant belongs to a member.
- **INVARIANT: the service and the database run in UTC.** The columns are `timestamp` WITHOUT time
  zone; TypeORM writes a JS `Date` in the process's local zone and reads it back the same way, so the
  instants survive only while the writer and the reader share one zone. Prod Postgres and the
  chat-delivery container are both UTC (read 2026-10-14). The one value still written by the
  database clock is `dm_group_members."joinedAt"` (`@CreateDateColumn`), which the exclusions read
  copies into an interval only when it heals a member enrolled by pre-030 code - the same UTC, a
  different clock by at most the skew between the two boxes' NTP.
- **The sender's OWN copy is dated too.** A sender never receives its frame back, so its copy used to
  carry no server time at all. `POST /send` now answers `receivedAt` - the very `Date` written into
  every recipient's `queued_message.createdAt` - and the outbox stores it as that message's
  `serverTimestamp`, in memory and on disk (`outbox.ts`, `patchServerTimestamp`). A control entry
  (reaction, edit, delete) is not stamped: it mutates a message whose own date must not move. A
  message the native background sender delivered (`/api/mls/push/send`) is not stamped: that route
  answers `receivedAt` too, but the native senders (Android, iOS) do not store it yet, so those copies
  stay undated and fall under the legacy rule below - the undated residue SHRINKS, it does not vanish.
- **Rows ingested by the OLD replay path are TRUSTED as dated, deliberately.** Before this change the
  Redis-stream replay dated an undated message by the bundle FRAME's time. Those rows are now
  indistinguishable from a real `serverTimestamp`, and they are not re-dated or distrusted: a bundle
  is always sent AFTER the message it carries, so the inflation only ever moves a date LATER. A
  message sent before a removal can be pushed into the window (held back: a cost, served by any other
  holder), and a message sent inside a window can be pushed past its end only if the bundle carrying
  it was sent after the re-add - by an answerer that did not filter it, i.e. a pre-change build, the
  old-client caveat below. Distrusting them would hold back every replayed row of every group with a
  window, for no case the old-client caveat does not already name.
- **A LEGACY undated message** - a copy written before that answer existed - is placed by its
  sender-stamped `timestamp` against every window **widened by `UNDATED_SKEW_MARGIN_MS`, one hour, on
  both sides**: held back inside, released outside. The hour covers a phone clock minutes off and an
  outbox that held a message before the network took it; it does NOT cover a clock wrong by more than
  that, or a message composed offline more than an hour before it was sent. Wider costs little - a
  held-back message is served by any member holding it dated - so the margin errs wide. One with no
  usable timestamp at all is held back. When no current member has a window nothing is filtered, and
  every answer is byte-for-byte what it was.
- **An unreadable window set carries no message**, logged `[HISTORY_ENTITLEMENT]`: the same silence
  an unreadable store produces, so another member or the next connection answers. Never an
  unfiltered answer. **The FULL bundle still sends one frame carrying the conversation state** (floor,
  read watermarks, pins) and no message - when the store is empty, when the windows are unreadable, or
  when every message was withheld - because an invitee has no conversation row yet and that frame is
  what gives it one.
- **A reply quote is the other road, and it is closed the same way.** A reply carries the quoted
  message's text, reaches every current member live and rides every later bundle. **The decision is
  made by the OUTBOX at the actual send** (`decideQuote` in `outbox.ts`), never at compose: it places
  the QUOTED message (memory, else the store) against every current member's windows through
  `quotePreviewEntitled`; inside one, or undatable while a window exists, the preview is blanked in
  the frame, the stored entry AND the sender's echo, which a later bundle would otherwise carry. An
  unreadable window set THROWS, so nothing is sent and nothing is blanked, and the throw is
  classified where it is raised (`getGroupExclusions`): a transport failure or a 5xx retries as a
  transient; an edge 403 is `SendEdgeRefusedError`; a gateway 403 - this account is off the roster
  - is `ExclusionsRefusedError`, an `ApiRefusalError` and deliberately NOT a `SenderNotActiveError`.
  The route refuses on the roster alone while the send refuses on this DEVICE's row, so a device
  `active` but roster-less sends freely; read as a send refusal, its first quoted reply ran the roster
  repair, which forgets the tree, on a device that was not broken. The outbox therefore quotes by id
  only and lets the SEND decide: accepted, the reply went out id-only; refused `sender-not-active`,
  the send's own arm repairs on its own proof. A blank is written to the entry and the echo only once
  the frame carrying it was accepted, so a refused send keeps the quote for the next decision. A
  known crash window remains, and it is accepted. If the app is killed between the accepted send and
  that write, this device's entry and echo keep the quote text that the frame did not carry. That
  text was decrypted on this device, so nothing reaches anyone who was out of the group. Composing reads nothing (the earlier compose-time GET cost a round trip per
  reply and blanked a quote for good when composed offline). The native outbox mirror sends frames
  built at enqueue, where no decision can be made, so it mirrors a reply with the quoted id and an
  EMPTY preview always - a background-sent reply quotes by reference only.

**The removal order - the record first, and the commit still reaches the removed member.**
`removeMemberAndBroadcast` calls the server first, then commits the MLS remove, then broadcasts
`memberRemoved`. A follower tab is refused BEFORE the record (`FollowerTabCommitError`): it may not
commit, and learning that from the commit, after the record, was a half-removal.

**A Remove that loses the commit race is REBUILT, never left to a sweep** (CC-2, 1.4.1 dev campaign,
2026-10-25). Between the record and the commit another commit can take the epoch - a concurrent Add,
a leaf refresh, another holder's collector - and the gate refuses ours. That refusal used to reach the
caller as a `CommitRefusedError` it only logged: the member off the roster and still in the tree, the
person who asked told nothing, and `removeStrayLeaves` finishing the job at some holder's next
connection. Now `commitMemberRemoval` (`groupActions.ts`) stages the Remove again on the tree that won,
under `rebuildableRefusal` (`CommitRefusedError.ts`) - the one rule the newcomer admission follows too:
only a refusal whose catch-up moved the epoch past the base the refused commit RECORDED, or an
overtaken seat claim (each one an eviction), is rebuilt, so the loop ends on a proof, never on a count.
`rate_limited` and `lock_budget_spent` are never rebuilt: the client decided them, not a race.

**"Out" is read from the tree, after any failure, and only on a tree confirmed current.** Two Removes
of one person (CC-3) rarely end in a gate refusal: the MLS lock is taken before the stage, and incoming
commits are applied under the same lock, so the loser waits while the winner's Remove is applied and
then its STAGE fails - openmls finds no leaf (`NoSuchMember`, `members.rs`), an untyped error from the
platform. So every failure of the commit except an unknown outcome (whose kept stage a later settle
decides) asks the tree again (`memberStanding`), and a tree without the member resolves `already-out`,
quietly: no warning and no second notice. That answer is trusted only at the server's epoch: a tree
behind an Add that re-admitted the member would say "out" of someone still in, so when the commit log
is ahead the rung-1 replay applies it first - the whole confirmation (log read, replay, re-read) under
the MLS lock, like the pipeline's rung 1, because the replay applies commits and may merge or clear a
staged one, and only sends may mutate the client outside the mutex (`readConfirmedTree`,
`confirmedTree.ts`, the one helper an Add's device filter uses too; the lock is not re-entrant, so a
caller must not hold it). Its replay keeps rung 1's books through the one helper the pipeline's gap
healer and a refused commit's catch-up use too (`replayAndRecord`, `commitReplay.ts`): persisted when
the epoch moved, un-marked in the epoch-gap registry on a heal, and never run past frames a refused
backlog is still bringing (a held replay leaves the tree unconfirmed) - and a tree that cannot be brought there is
`tree-unconfirmed` - surfaced, never "out". Every other ending throws `MemberRemovalNotCommittedError`
and the person who asked is told by TYPE (`reportMemberRemovalFailure`): "removed, the key change
finishes at the next connection", never "failed", because the record IS the removal and is not rolled
back. The collector completes that case from durable state (roster against tree). A follower-tab
refusal it carries as its `cause` still reaches its own sentence.

**The `memberRemoved` notice follows the record** (decided 2026-10-25): sent on `committed` AND when
the record landed but the commit did not - safe, because the record already cut the removed device's
rows - and not on `already-out`. What that rule does NOT promise, stated as it is:

- **`already-out` sends no notice, whoever took the member out.** A concurrent Remove of the same
  person by another member sends its own; a holder's collector (`removeStrayLeaves`) sends none, and
  the members then see the roster change without the line.
- **Two gestures can both send it.** A `concurrent_commit` refusal that moved nothing is not rebuilt,
  and there may have been NO winner - the lock holder's commit can itself fail or land only later. The
  member is still in the tree, so this gesture surfaces `MemberRemovalNotCommittedError` and sends the
  notice, and a concurrent Remove of the same person sends its own: a duplicate line, accepted.
- **An unknown outcome still attempts the notice, and the attempt is a resubmission.** A send into a
  group whose state holds an unresolved commit is not refused outright: `sendMessage` settles the kept
  commit first (`settleBeforeSend`, `BaseMlsService.ts`) and sends once it is merged or cleared. Only a
  resubmission still unanswered refuses the send (`CommitOutcomeUnknownError`), and the notice is then
  lost with its `NOT delivered` line - a true one, since no notice is sent later.

**Why the record stays first rather than moving after the commit.** The record is what gates
delivery: it deletes the member's device rows, so no application frame reaches them from that instant,
while the parting hint below still queues them the Remove commit that names them. Committed first, the
removed devices would stay on the fan-out until the record landed - or for good if it then failed -
with a tree that says they are out; and the exclusion window would open after the commit, so a frame
sent between the two could later be served to them as if they had been in.

**The removed device's replay is refused, by the same ordering, and that is a separate item.** The
Remove commit it is queued is built on whatever epoch the group reached - one epoch past its own
whenever any commit landed between the record and the Remove (a lost race always does, rebuilt or
not). It sees an epoch gap, asks for the commits it missed, and is answered `403` on
`commits?sinceEpoch` (and `user-members`, `group-info`): it is no longer a member, so it is not
entitled to them. The 403 is the answer - "you are out" - but the replay reads it as an error
(`[GAP] replay error ... 403`). Classifying it at the throw and retiring the conversation from it is
an eviction decision, gated on proof, so it is owed separately ([backlog](../backlog.md)). `removeGroupMember` (called by somebody other than the removed person) reads the
removed person's devices and writes each into the Redis hash `group:parting:{gid}` (`partingKey`),
then deletes their device memberships, then deletes the roster row and closes the interval in one
transaction. **The hint is written FIRST** because the rows it is derived from are gone after the
delete: written after (the third review's order), a crash in between lost it silently and a retry
found nothing to derive it from. Redis cannot join the Postgres transaction, so the order is what
makes it crash-safe - and an entry for a removal that then fails is harmless: it names devices that
are still members, which the fan-out reaches as members and never twice, and only a commit declaring
that person's removal consumes it. The removing client's commit DECLARES whom it removes
(`ValidateCommitBody.removes`: a person, or one device of theirs - `removeMember` and
`removeMemberDevice` both say so through `runCommitTransaction`), and `validateCommit` hands the
fan-out the parted devices that declaration names - so the Remove commit is QUEUED to the removed
devices, which process it and learn they are out instead of keeping epoch-E keys until a refused
send. The entries it names are deleted once the commit is queued.

**The hint is keyed to the commit's declared intent, never to "the remover's next commit"**, which
is what the second shape did, and what four cases broke (third review of #1878):

- two removals in flight by one member: the first commit consumed both people's entries, and the
  second person never received their own removal - now each commit names only its own person;
- a global admin who removes somebody and never commits: the entry waited for a commit that would
  never come - now whichever holder collects the stray leaf (`removeStrayLeaves` commits through
  `removeMemberDevice`, which declares) delivers it;
- an older build that declares nothing: its commit consumes nobody's entry.

**`removes` and `admits` are DECLARED by the committing client, and any member can forge them** - the
server cannot read an MLS commit. What a forged `removes` can do is bounded by the hint: it can only
route a commit to a device the server itself parted, and so only SUPPRESS a hint (consume an entry
with a commit that removes nobody, so the real removal later reaches nothing) - never route a frame to
a device that was not removed. A forged `admits` is bounded by the existing KeyPackage check. Both are
the hostile-member case below, which a rule honoured by correct clients does not cover.

**An entry ends on state, never on a clock**: consumed by the commit naming it; cleared when its
device is in the tree again (admitted by a commit, or committing itself - an external rejoin); gone
with the group (`GROUP_REDIS_KEY_PREFIXES`). What remains is an entry no commit will ever name - a
removal committed by an older build before its server call, which reached the device anyway - kept
until the person returns or the group ends, one small field per device. The hash carries no TTL, and
`volatile-lru` only ever evicts keys that do. It is a hint, never the record: losing it (a lost Redis
volume, or a failed write, logged) costs only that delivery, which the removed device then learns from
its next refused send, exactly as before.

What closes a failure in the middle (a server record with no commit, then a re-add) is the SERVER,
not the tree: **`GET /history` and `/history/batch` DROP every row inside the READER's own windows,
and keep reading so the page stays full** (`withholdExcludedHistoryRows`, `readHistoryStreamPage`).
So a stale leaf left by a failed commit - its device decrypts every frame at the old epoch - finds
nothing to decrypt in the stream for the gap, and live delivery never queued it a copy while it had
no device membership. **Dropped, never marked**: the second shape answered such a row as
`{ id, withheld: '1' }`, and every store build shipped before it decodes `content` unconditionally -
the decode threw, the replay's catch only logged, the cursor was never saved, and every later replay
threw on the same row, so a re-added member on a store build lost stream catch-up for that group for
good. A page is filled past what it drops because every build ends its walk on an empty page. **The
caller sets how much it is handed, never how many reads it costs**: the fill reads chunks of at least
`HISTORY_FULL_PAGE_LIMIT` (1000) and keeps `limit`, so a stream at `HISTORY_STREAM_MAXLEN` (8000)
costs at most eight `XRANGE`s - a `limit` of 1 used to buy one read per row.

**A dropped tail is RESCANNED on every launch, and that is a known, bounded cost.** A cursor advances
only over rows it was handed. So a re-added reader whose only unread rows lie in its own window reads
them again at each launch: at most the stream's `MAXLEN`, in whole chunks. A cursor followed only by
dropped rows up to the head counts as caught up, so it writes no log line per launch.

**Rejected: naming the tail so the cursor jumps it** (`skipTo`, built in the fourth review of #1878,
deleted in the fifth). A saved `skipTo` could hide entitled rows FOR GOOD, which is worse than a
bounded rescan. The exact scenario:

1. `ensureGroupMember` is interrupted between its two statements. The invitation join runs it with
   no transaction, so it leaves a roster row with only the CLOSED interval of the earlier
   membership.
2. The interval read took that last close as a window open to now. Every row since the removal was
   dropped.
3. `skipTo` moved the cursor to the head.
4. The later repair opens the interval at the roster row's `joinedAt`. The window shrinks, and the
   rows after it become entitled again.
5. The saved cursor is already past those rows, permanently.

Three more things made it unsafe:

- the guards against jumping a kept row were untested;
- the client did not check that a `skipTo` lay ahead of its cursor and at or before the walk head;
- a client with an empty local store clears its cursor on every launch, so it never helped there.

What a future version must prove first is in the [backlog](../backlog.md) (P3).

**The interval read repairs before it filters**: a roster member with no open interval gets one from
their roster row's `joinedAt` (`openMissingIntervals`, shared with `GET .../exclusions`, one ERROR
line each time), rather than being read as out from their last close.

The roster read and the insert run in ONE transaction, with the roster row held `FOR SHARE`. Without
the lock, a removal committing between the two found no open interval to close. The insert then left
an OPEN interval with no roster row, which a re-add's ignored conflict kept, so no window covered the
removal. With the lock, the removal's DELETE waits and then closes the repaired interval.

Only what `RETURNING` names was stored, so a concurrent repair that lost the conflict neither logs nor
counts a row. Both callers re-read the table after a repair attempt rather than patching their list.

The window read is per group, inside that group's `try` on the batch route: a failed read answers
that group empty - never unfiltered - and serves the rest.

The exclusions read also counts every person holding a device row (`dm_device_group_memberships`,
either status - the enum is `pending | active`, and both mean a device the tree admitted), not only
the roster: an add commit admits devices before `registerMember` enrols the person, and the union
must include their windows from that first moment. It reads DISTINCT users, not rows.

Rejected designs, and why:

- **Commit first, then record.** A server failure after a successful commit leaves a person with no
  leaf still on the roster, and the next re-add, `welcome_request` or reconciliation undoes the
  removal silently - the half state that must never be silent.
- **A `leaving` device status** delivered by the fan-out and dropped afterwards. It touches the
  two-writer device state machine and every status filter in the service; the parting hash gives the
  same delivery as a pure addition.
- **A separate table for parting devices.** A migration and an owned-table pin for a hint whose loss
  costs one delivery.
- **Refuse a re-add while a stray leaf of that user exists.** The server cannot see the tree, and
  the old state could still walk the stream - the stream filter closes that whatever the tree holds.
- **Clear every entry when the group's next commit lands, whoever sends it.** A state-based end, but
  the wrong state: two removals in flight lose the second person's delivery to the first commit.
- **Mark a withheld stream row, or gate the shape on the client version.** The marker stalled every
  older build (above); the API carries no client version to gate on, and a shape no build can trip
  on needs no gate.

**Answering in chunks.** `sendBundleChunks` re-reads the exclusions for EVERY chunk. What can change
mid-answer is a RE-ADD: a removed person is not a current member, so their window is absent from the
union until the re-add makes them one, and every chunk sealed after it is one they can open. A
removal mid-answer cannot widen what is sent - its window starts at the removal, after every message
already selected. Binding the answer to an epoch was rejected: the Tauri `getEpoch` is a cached value
that can be stale, and a stale leaf opens the old epoch anyway. The cost, justified rather than
optimised: one read per chunk is three indexed reads on `groupId` (roster, DISTINCT device users,
intervals) - ~86 for a 4 000-message full bundle, which happens on a new device - against the chunk's
own `POST /send`, which inserts one queued row per recipient device. An unreadable first read sends
nothing; an unreadable later read stops the answer there. **The narrow window that remains**: a re-add
landing between a chunk's read and that chunk's send, if the answerer has processed the add commit
before sealing it - one chunk at most, and only of messages the person's window covers.

**The receiver - hygiene, not a control.** The `history_bundle` handler drops a message it would
ADD by the same `withholdReason` the senders apply, against its OWN windows - a dated message inside
one, an undated one near one, an undatable one - one log line per drop (`dropOwnExcludedMessages`);
messages it already holds are not checked, so a bundle restating its store costs no read. The
Redis-stream replay (`historySystemEvents.ts`) applies the same filter to a bundle it replays, and no
longer dates an undated message by the bundle frame's time, which is when the BUNDLE was sent and
would have placed the message wrongly. An unreadable window set ingests none of that frame's
messages, and says so.

**What it does NOT cover.**

- **AN ANSWERER ON AN OLDER BUILD.** The control runs on the device that ANSWERS, so the guarantee
  holds only when that device runs a build carrying this change. A member still on an older build
  answers a history request exactly as before - unfiltered - and the re-admitted member's device
  ingests it if it is itself older too (a current build drops what falls in its own windows, which is
  hygiene and not a control). **The guarantee is complete only once `minClientVersion` reaches the
  build that ships this**; raising it is the user's call, and it stays where it is until they make it
  ([backlog](../backlog.md)).
- A hostile client - a member that kept its plaintext, or an answering peer running modified code -
  can hand anything to anybody. This is a rule honoured by every correct client, not cryptography.
- **A member can open an artificial window**: removing someone and adding them back seconds later
  makes everything in between - and the hour either side of it for legacy undated copies -
  unrestorable to every new device for as long as that person stays. Recorded in
  [backlog](../backlog.md); nothing distinguishes it from a real removal.
- Removals that happened before migration `030`: nothing recorded them, so a person removed then
  and re-added later has no window.
- A member enrolled by a container still running pre-030 code during the deploy that applied the
  migration has no open interval. The exclusions read opens it from the member row's `joinedAt` the
  first time it meets one, and logs that ERROR once - the repaired row is what stops the line, so it
  is not repeated - but a removal made by such a container before that read recorded no window.
- **Live control frames about a gap message reach a re-added member.** A reaction, a read receipt
  or an EDIT made after the re-add to a message sent while they were out is delivered live like any
  frame. A reaction or a read carries only ids and an emoji; an edit carries the NEW text of a
  message they never held. Not filtered: the frame names a target the client may not hold, and the
  server cannot read it.
- **The deploy transient.** A container still running pre-030 code during the rollout deletes a
  roster row without closing the interval; a re-add then meets the open row and `ensureGroupMember`'s
  `orIgnore` keeps it, so that removal has no window.
- **An offline self-leave is dated late.** Its server half is retried from `pendingGroupExits`, and
  the window starts when the server RECORDS it, not when the person left - messages between the two
  are not withheld.
- **A stale leaf after a failed commit** survives until `removeStrayLeaves` runs on some holder; the
  stream filter keeps the gap from it, but live frames sent after a re-add reach it like any member.
- Reconciliation still READS a withheld message as missing: the asker's digest lacks it and asks
  again on its next connection. That is the open P2 in [backlog](../backlog.md) (an exclusion window
  called a loss), unchanged in cost by this.

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
| pin state | last-write-wins per message on its own `at` | yes |

**The pin was the one mutation carrying no clock, and that is what made it hard.** Every other one
here dates itself - a reaction dates each `(user, emoji)` pair, an edit dates itself, a deletion is
absorbing - while `pin`/`unpin` carried only a message id. With no date there is no merge: a union
lets a peer that has not seen the `unpin` resurrect a pin, and a replacement makes the outcome
depend on which answer landed last. So the frame now carries `at`, both legs, exactly as a
reaction's two legs do, and an `unpin` is a dated TOMBSTONE rather than a removal. The register
travels with its tombstones for the symmetric reason: a snapshot of what is merely pinned omits the
answerer's `unpin`, which is precisely the entry a stale peer needs in order to lose.

**Both carriers are needed and neither is redundant**: the frames converge a device that is
following along, and the register covers the frame that has aged out of the server's window while
the pin it created has not. That is what made this a hole rather than a policy - a channel pin came
back on a fresh device, because the server re-serves it, and a DM pin did not (MUT-15). Bounded at
500 entries per conversation, oldest first, because a tombstone is never discharged by anything.

Two of these are corrections, not restatements of today's behaviour - see
[Defects this work must fix](#defects-this-work-must-fix), D3 and D5. Pruning is **not** monotone,
which is exactly what the floor is for: pruning below it is invisible to the merge, and pruning above
it is forbidden.

### Restored history carries its author's signature (2026-10-22)

A `history_bundle` is written by whichever member answered, and until this change every field in it
was taken on that member's word. Since this change the restored history of a private conversation
(1:1 and group) carries each message's ORIGINAL author signature, and the reader decides from it.

**The proof.** mls-core signs every application frame it sends (`send_authored_message`,
`mls-core/src/authorship.rs`) with the device's MLS credential key - the key Graine v2's endorsement
uses - over `lp("canari-mls-author-v1") lp(groupId) lp(userId:deviceId) lp(SHA-256(body))`, `body`
being the exact `AppMessage` bytes (message id, the author's timestamp, the content). The proof
travels INSIDE the plaintext, appended as `AppMessage` field 14 (`AuthorProof`), so MLS encrypts it
with the message. On receipt mls-core keeps the proof only when it names the frame's MLS sender and
verifies under that sender's leaf key; otherwise it strips it and logs `[AUTHORSHIP] REFUSED` at
ERROR. A frame from an older build simply has none.

**Kept beside the message.** The device records `{body, proof, group}` in the sealed row payload
(`StoredMessage.authorship`; `editProof`, `deleteProof`, and `MessageReaction.proof` for the
mutations), for frames it received AND frames it sent (the outbox records its own). `group` is the
conversation the proof was signed in: a row can move between conversations (a merged DM, a re-key),
and a proof checked against the wrong group would read as a forgery. A deletion purges the original
bytes and keeps only the author's signed tombstone.

**Relayed and checked, one rule for every way a bundle arrives.** `serializeForBundle` relays the
proofs; `restoredAuthorship.ts` decides each entry
([`messageAuthorship.ts`](../../../frontend/src/lib/crypto/messageAuthorship.ts) does the crypto,
with a shared vector against the Rust side). `bundleVetting.ts` (`vetBundle`, `mergeVettedRow`) is
the one orchestration, used by the live handler (`systemMessageHandler.ts`) AND by the archive
replay (`historySystemEvents.ts`), which sees a bundle an older build wrote durably: the same
verdicts, marker, vouching rule and upgrade, only the writes batched per page:

| Entry | Taken when | Otherwise |
| --- | --- | --- |
| message | the author's proof verifies and names this id and this author - content and timestamp are then read from the SIGNED bytes, never from the relayer's fields; or the relayer IS the author | no proof, or a proof signed in another conversation: kept, drawn normally and MARKED `restoredUnverified` (a small "non verifie" under the bubble, explained on tap - never hidden); a proof an anchored pin contradicts, or a malformed one: REFUSED |
| edit, deletion | the author's signed event names this message; or the relayer is the author | dropped, never applied on a third party's word - nor its "edited" flag and time, which are taken on the same grounds as the edit, or onto a row already marked |
| reaction | the reactor's signed frame proves exactly this state; or the relayer is the reactor | dropped |

**"The relayer is the author" holds only for a row the relayer vouches for.** A row a device holds
MARKED is relayed with `authorUnproven: true` (`serializeForBundle`), and the reader then gives the
relayer's own word no weight for that row's message or edit (`relayerVouches` in
`restoredAuthorship.ts`): the device holds a third party's word, not its own, even when the row names
its own user. Only the row's own proof can then verify it.

**A marked row is upgraded by proof, and only a marked row.** A held row marked `restoredUnverified`
is replaced ENTIRELY by a later copy whose proof verifies here - sender (the proven author: a marked
row's sender was a relayer's word like its body), body and time from the signed bytes, the mark and
the unproven edit state cleared, in memory and at rest (`upgradedRow`, `upgradePatch`); a changed
sender is logged at WARN. A held row that is not marked is never replaced. The archive replay holds
the rows its page already queued like stored ones - a bundle naming one updates it in place, never
queues a second, and the same merge reaches that row's copy in memory when both name one author -
and its batch write never downgrades a stored proven row, and keeps a stored proof the incoming copy
lacks (`replayedStoredRow`). Not downgrading is about the copy's own word only: an author-signed
tombstone or edit that a marked copy carries still applies to the proven row, the edit's signed TEXT
onto that row's own body (`provenRowUnderMarkedCopy`). Memory follows the batch write in the same
pass: a row it shows marked that the page wrote proven - a decrypted original included - is replaced
by the written row, a tombstone surviving (`provenRowsIntoMemory`). Within one bundle that
carries an id twice, a proven copy wins over a marked one in either order
(`systemMessageHandler.ts`, `upgradeUnverifiedRows`).

**Mutations need a signature, and that has a cost (lead decision, 2026-10-22).** An unsigned edit,
deletion or reaction is dropped, so one made by an author on a client older than signed authorship
is missing from restored history until that author updates. The unsigned MESSAGE is the only shim,
with its removal condition in [legacy-compatibility](../legacy-compatibility.md).

**Keys - only those this device trusts, tried in order.** The author's leaf in the current tree,
which MLS authenticated, then the keys this device pinned for that device
(`pinnedSignatureKeys`, the key-binding work) - so an author who has LEFT the tree still verifies.
A key the SERVER publishes is never evidence either way: it can neither verify a proof (a server
could list a key for a device that never existed) nor accuse one (an erasure, or a server, can drop
a real key). An author with no trusted key is `unproven` - kept, marked, exactly like an unsigned
message. Every lookup and comparison uses the ONE canonical identity of `leafIdentity.ts` (Rust's:
ASCII letters lowered, nothing else), and a bare legacy `userId` names a user, never a device, so
a proof naming one never verifies - and never accuses either: it reads `unproven`. mls-core signs
as its credential, always `user:device` (one constructor in `state.rs`, whose loader refuses any
other identity), but nothing proves a user id can never hold a colon.

**Verifying and accusing are different questions.** A key that verifies proves the author; a key
that fails to verify accuses only if it is the key the author held WHEN it signed. The current tree
cannot say so - a heal's re-Welcome replaces the leaf, and the proof names no epoch - and a pin
re-taken after a prune may be a server-served key. So neither accuses: a contradiction is
`unproven`. Only a pin the key-binding work marks ANCHORED (`DevicePin.anchored`: no prune since
it was first taken, so it holds every key this device saw for that device) accuses - a signature
valid under none of its keys is `forged`, as is a malformed proof.

**An edited message is verified only with its edit.** The signed bytes are the ORIGINAL body. A
restored message marked edited whose edit is not proven by the author's signed `edit_message` keeps
the relayed (edited) body and is marked unverified - a retracted text never comes back looking
authenticated. The archive replay of `edit_message` and `delete_message` frames stores their signed proofs like the live path, and a replayed bundle goes through the same `bundleVetting.ts` as a live one.

**A refusal is loud.** Every refused entry is an ERROR line and an integrity finding
([`integrityFindings.ts`](../../../frontend/src/lib/mls-client/integrityFindings.ts)), reported once
per session to `POST mls/integrity-finding`. The route accepts a report only from a member of the
group; it logs the authenticated reporter as a fact and the peer as `claimedPeer`. The level is read
from the report's typed `proven` boolean, never from its free-text `detail`: `false` (an `unproven`
fork) is a warn, as in mls-core and on the client; `true`, or no boolean, is ERROR. The UI for
findings comes later.

**Only mls-core's verdict records a proof.** Both bindings hand `author` (`unsigned`, `verified`,
`refused`) beside each decrypted plaintext, and `recordAuthorship` keeps a proof on `verified` alone.
It never re-derives the answer from the bytes: protobufjs skips a group field (wire types 3 and 4)
that mls-core's parser does not read, so the two can disagree on whether a plaintext ends with a
field 14, and only mls-core checked the signature.

**A verified row needs a signed timestamp.** A proof whose signed `AppMessage` carries no `sentAt`
is treated like no proof (marked, or vouched for when its author relays it): verified, the row would
otherwise carry the relayer's timestamp under the author's name.

**What the fork claim makes visible.** The fork check's claim
([mls-protocol](mls-protocol.md#fork-detection-a-signed-epoch-fingerprint-in-every-application-frame-2026-10-22))
sits in the `PrivateMessage` authenticated data, which MLS authenticates but does not encrypt. It
carries the sender's `userId:deviceId`, a 16-byte epoch fingerprint and a signature, readable by
everything that handles the frame's bytes: the delivery service and its stored queue and archive
rows, every member device that receives or fetches the frame, and the push providers (FCM, APNs)
when the frame is inlined in a notification. The delivery service already records the sending user
and device beside each frame, and a push payload already names the sending user (`senderId`); the
device id in a push payload is what the claim adds there. The author proof of this section is inside
the ciphertext and adds nothing visible.

### The acting device writes its own notice

**Found by the 1.4.1 dev campaign (4 draws in 10, deterministic), fixed 2026-10-25.** A visible
notice - a member added or removed, a rename, a photo change - is written on every member's device
from the frame, under the id the sender minted (`mkVisibleSystem`). MLS never hands a device its own
application message, so the ACTING device wrote nothing. Its store was one row short of every other
member's, and the history exchange repaired that the only way it can:

1. the acting device's state key differed from a member's (`Keys differ ... asked <them> to describe`) - on every connection until the step below, not for ever: the key covers ids, not content or time;
2. the member's diff named the notice as missing there and sent it (`Diff sent: 1 of 1 requested`);
3. the acting device vetted a row authored by nobody, which no proof can cover, and kept it MARKED: `[AUTHORSHIP] 1 restored message(s) ... carry no author proof - kept, marked unverified`.

**The fix is at the source, and it is the one the channel invitation card already used**
(`inviteMemberToChannel`): `sendVisibleNotice` (`visibleNotices.ts`) sends the frame and, once the
delivery service has accepted it, writes the acting device's own row under the frame's id. Every
device then holds the same row, the state keys agree, the diff is empty, nothing is relayed and
nothing is vetted - no filter in the digest, the diff or the vetting. Its callers:
`processBulkAddition` (`memberAdded`), `renameGroupAndBroadcast`, `setGroupImageAndBroadcast` and
`removeMemberAndBroadcast`. The row follows the frame exactly, so it follows the race rules: a
`memberRemoved` on `committed` and on a record that landed uncommitted, none on `already-out`
("The removal order", above); one `memberAdded` for a rebuilt Add, none on
`already-in-tree` (the winner announced it) or an Add abandoned before its stage (`AddAbortedError`).
A frame that was not accepted writes no row, since a row only this device
holds is the same divergence the other way.

**What runs, in order.** (1) The text is rendered: `resolveDisplayNames`, which may fetch a profile
and so can delay the FRAME (it never throws - an unresolved name stays the id). (2) The frame is sent
and the call waits for the delivery service's acceptance. (3) The own row is written through
`addMessageToChat` with `soleWriter` - memory, then the IndexedDB / SQLite row - never deferred into
a bulk drain's buffer, which a second drain start or `resetMessageCatchupState` discards unflushed
(the own-message rule, WP-ECHO-1, for the same reason: nothing will ever write this row again).
(4) For `memberAdded`, the caller's MLS checkpoint follows - so a local write sits between the send
and that checkpoint; a write that FAILS is logged (`[NOTICE] ... was DELIVERED ... not written`, at
ERROR) and never thrown as a failed send, so the checkpoint is still reached.

**A kill between (2) and (3) is accepted, and repaired only by the digest diff.** The members hold
the row and this device does not, so its next reconciliation reads `Keys differ`, the diff relays the
notice, and it lands here ONCE, marked unverified - exactly an older build's behaviour, for one
notice. No line marks the window: a "sending" line before every send would be a second line per
notice to say what the `written` line's absence already says, and the evidence of the repair is the
existing `[AUTHORSHIP] ... kept, marked unverified` line naming that conversation.

**And the handler that called it must not write a pre-await
snapshot back**: `handleRenameGroup` / `handleSetGroupImage` did `{ ...convo, name }` after the
await and erased the notice just written - they now patch the conversation as it stands
(`patchConversation`). A departure (`memberLeft`) and a deletion
(`groupDeleted`) write none either: no device of the acting user draws them (the handler skips its
own departure and purges on its own deletion), so all its devices agree on holding nothing.

**One rendering.** `renderVisibleNotice` draws these four events for the acting device, the live
handler and the archive replay, which had two copies of it between them. The replay now draws the
photo notice it never drew, which had left a device that met that frame only in the archive one row
short as well.

**Mixed versions need nothing.** An older acting device still lacks its row, and converges as before
(one relay, marked). An older member's digest names the notice the updated acting device now holds,
so the diff is empty. Rows that only one device should ever hold (an outbox line, an eviction notice)
are a separate defect ([backlog](../backlog.md)).

### Reactions

Each `(user, emoji)` pair carries its own timestamp and an on/off state; the larger timestamp wins.
Converges without tombstones, and stays bounded - a place/remove cycle does not grow the set.

**Shipped.** `messageReactions.ts` holds the whole rule: `applyReaction` for one frame,
`mergeReactions` for a peer's set, both last-write-wins on `at`, and `activeReactions` for what the
UI renders. Equal timestamps keep what is already held, so replaying a frame onto its own result is
a no-op rather than a flip. The rule it replaces adopted a bundle's reactions **only when the
receiver had none**, so a removal never reached anyone holding a stale placement.

Three consequences worth stating, because each one was a bug in the old shape:

- **A removal is an entry, not a deletion.** Dropping the pair from the list left nothing to send,
  which is why removals could not travel. It stays, carrying `removed: true` and the time it was
  taken back, and there is exactly one entry per pair - a place/remove cycle does not grow anything.
- **Both legs are the same frame.** Taking a reaction back was a `SystemMsg("remove_reaction")`
  carrying JSON while placing one was a typed `ReactionMsg`; one shape had nowhere to put the
  timestamp the merge needs on both. `ReactionMsg` now carries `at` and `removed`, and the old event
  survives only as a decoder for stream entries written before the change
  ([legacy-compatibility](../legacy-compatibility.md)).
- **The cap is a send-side rule.** The distinct-emoji cap used to be enforced on the receive path
  too, so a device at the cap silently refused a frame another device accepted - a permanent
  divergence produced by the very mechanism meant to prevent one. A frame that reached the group is
  a fact; the cap now limits only what the user may place.

### Deletion purges

A deletion replaces the content at rest, everywhere it lands, and removes the corresponding entry
from the shared log. What remains is the tombstone.

**The at-rest half is shipped.** The bundle merge sets `isDeleted` AND replaces `content` with the
tombstone, in memory and in the row it writes. It used to set the flag alone, so the write put the
original plaintext of a deleted message straight back on disk - and the next bundle this device
answered read that row and sent the original text on to somebody else.

**The shared-log half is not, and it needs a decision.** The server holds ciphertext and cannot tell
which stream entry carries a given message, so nothing there can act on a deletion by itself. Three
ways to give it one, none of them free:

- the deleting client locates the entry by replaying the stream and names it - correct, but the cost
  grows with how far back the message is;
- the server indexes message id to stream entry id - it would have to be told the id in the clear on
  every send, which puts a stable per-message identifier in the server's hands;
- leave it. Correctness does not depend on it: the `delete_message` mutation is itself in the shared
  log since the durability split, so a device replaying the log applies the deletion after the
  message and converges on the tombstone. What is lost is only that the original ciphertext stays in
  the log until the cap or the TTL evicts it.

Correctness is therefore already covered by the third option; the first two buy forward secrecy for
a deleted body, at a price. **Open question** - see the table at the end.

### Read state becomes a watermark

**SHIPPED.** One monotone value per participant - *read up to T* - merged as `max`, replacing the
per-message `readBy` array. It lives on the conversation (`Conversation.readWatermarks`,
`ConversationMeta.readWatermarks`, SQLite schema v6), travels as a `read_watermark` frame - a
mutation, so silent and durable - and rides on every `history_bundle`. Everything derived from it -
who has read a message, the unread count, how far reading a conversation moves the mark - is in
`$lib/utils/chat/readState.ts`, which absorbed `unread.ts`.

**T is the message's own client timestamp**, `messageTime` - the PRIMARY key display order uses, not
`serverTimestamp`, which is only a tie-break. A watermark ordered differently from the list it
describes would leave a message marked read while the one visibly above it stayed unread. And it is
drawn from the MESSAGES rather than from the clock: a device an hour fast would otherwise mark an
hour of unread messages read for everyone, permanently, the merge being `max`.

What it buys, beyond travelling in the shared log so a reinstall recovers read state with no peer
online:

- **it does not depend on which messages a device holds.** A `readBy` entry can only exist where the
  message does, so a catch-up delivering an older message marked it unread - the receipt for it had
  gone out long before. A watermark already covers messages the device has not seen yet;
- **one value per participant instead of one array per message**, so a page of a thousand messages
  costs one entry per reader, and read state is untouched by the batch save that writes them;
- **D2 falls out of it**: the reading device writes its own watermark to its own row (`MainChatPage`,
  optimistic update + `saveConversation`), so what this device read survives a reload without waiting
  for a peer to hand it back.

Two consequences to keep: an edit no longer resets read state (`readBy: []` used to mean "read by
nobody again"), because a monotone value cannot express it and a peer that never saw the edit would
never agree to move back; and the pre-watermark `read_receipt` frame is still DECODED, translated
into an instant using the messages the device holds - see
[legacy-compatibility](../legacy-compatibility.md).

#### The unread count is DERIVED from the watermark, on every path that writes it

The badge is not a tally kept up to date by whoever adds a message; it is `countUnreadForUser`
applied to this user's own watermark. Four sites write it, and until 2026-08-30 only two asked that
question - the history-bundle merge and the post-replay recount. Both add paths, `addMessageToChat`
and `batchAddMessages`, inferred "unseen" from "arrived just now".

**That proxy is exactly what a reconciliation breaks.** A replay delivers frames that are new to THIS
device and were read long ago on another one, and it delivers them interleaved with the read receipts
that zero the count. Applied in arrival order, the pair replays the conversation's entire read
history in fast-forward: the tile flashed read / unread / read for as long as the reconciliation ran
(reported from real use, 2026-08-30). The count was not merely late - it was answering a different
question from the one the badge asks.

The watermark is persisted on the conversation and is therefore already loaded before any frame
arrives, so nothing had to be fetched to fix this: the add paths were ignoring a fact they held.
Deriving makes the result independent of the ORDER frames arrive in, which is the property the blink
violated and the one the tests pin.

Aligning the two also settled a disagreement between them: `batchAddMessages` had always excluded
system messages from the count, and `addMessageToChat` had not, so a "X joined" notice raised a badge
for something nobody reads - on one path only. `isUnreadForUser` is now the single place that decides,
which is what keeps the four sites from drifting again.

#### The two hydration paths are MIRRORS and must be edited together

`toConversationMeta` and the in-memory seed in `loadExistingConversations` build the same object from
two directions, and a field added to one is silently absent from the other. A fix to read state was
defeated by exactly that: `readWatermarks` was written and never read back, so read state was correct
until the first restart and wrong afterwards - which reads as a persistence bug and is a hydration
one. **A field persisted but never read back is worse than one never stored**: the write succeeds,
nothing reports it, and every test that stays inside one session passes. When adding a field to the
conversation, change both, and assert it across a reload rather than within one.

#### The sender says only what is new, and the outbox keeps one watermark per conversation (2026-10-15)

**Why the SENDER.** A `read_watermark` is an MLS application frame. Decrypting it moves the receive
ratchet, so a receiver cannot skip it, nor the checkpoint that follows it. A Pixel 6a cold start
logged 135 checkpoints in 16.9 s (114 ms median). 50 of them (5.6 s) followed drains that held only
read watermarks. #1879 tried to skip the checkpoint on the receiver. It was rejected: its proof
covered the manager and not `mls.bin`, and it gained 4 %. The only place that can send fewer frames
is the sender. A watermark is latest-wins (merged as `max`), so a frame a newer one covers carries
nothing.

**What the code emitted, counted from `MainChatPage`'s receipt effect before this change.** For a DM
or an MLS group (a salon's mark goes to the server and is out of scope):

| Gesture | Frames |
| --- | --- |
| Open a conversation that has unread messages | 1, after the 2 s debounce |
| Scroll, or load older history | 0. The target is the max over every loaded message, and older rows are below it |
| A peer's message arrives while it is open and focused | 1 per 2 s window |
| **Send a message** | **1, 2 s later.** `watermarkAfterReading` counted own messages, so the reader's mark moved over their own send |
| Leave within 2 s of reading | **0, and the receipt was LOST.** The cleanup zeroed the pending value after the local mark had already moved, so nothing sent it again |
| Read while offline, then reconnect | one frame per debounce window, all sent on reconnect |

In an active DM with both people reading, each message cost two watermarks: the reader's and the
sender's own. Every member's device decrypts both, the author's other devices included.

**What changed: three rules.**

1. **A mark moves over FOREIGN messages only, in a DM or an MLS group** (`readMarkTarget`,
   `readState.ts`). Receivers learn nothing from a mark that moved over the reader's own send.
   `seenByAnchors` already places an author at their own message, and `isUnreadForUser` never counts
   one. A salon still counts its own and system rows: the server counts against that mark, and #1619
   and #1820 rely on it. The own-advance frame was the sender's half of every exchange, and it is
   gone. This is "piggyback on the next send" in its exact form: the message itself announces that
   its author has read up to it.
2. **The outbox keeps ONE unsent watermark per conversation** (`OutboxController.enqueue` with
   `latestWins`, `sendReadWatermark`). A new watermark for a conversation that a queued one already
   covers (`queued.at >= at`) is not queued, so a mark never moves backwards on the wire. Otherwise the
   new entry is WRITTEN FIRST, and only then are the older unsent ones withdrawn, through the same
   `withdraw` path as a cancelled message: the durable row, this flush's snapshot, the other tabs and
   the native mirror. A row already on the wire is withdrawn too (deleted, not retried), and the
   newer row follows it. Only `read_watermark` entries of the same conversation are touched. Reactions,
   edits, deletes and pins are not latest-wins per conversation and never enter this path.
3. **Leaving the conversation, or the app leaving the screen, DELIVERS the pending watermark**
   (`createReadMarkDebounce`, `readMarkDebounce.ts`). It used to drop it. Both are events, so the
   coalescing between reading and leaving has no clock of its own.

**The invariants, and what holds each one.**

| Invariant | Held by |
| --- | --- |
| The LAST watermark is eventually sent | It is either pending in the debounce (delivered on expiry, leave or off-screen) or queued in the outbox, which delivers it durably. Supersede never withdraws the newest entry |
| A crash loses at most superseded watermarks | Write-before-withdraw. A crash between the two leaves BOTH rows, which send in order (older first), and the receiver's `max` makes that harmless |
| A watermark never moves backwards | Covered-means-not-queued, at enqueue. The receiver merges by `max` anyway |
| A superseded row being sent is not resent | `withdraw` DELETES the row of an entry on the wire and marks it cancelled, so it is not retried if that send fails. The newer row covers it. It answers `withdrawn: false` only so the caller knows the peers may have the frame (for a cancelled MESSAGE that is what sends `delete_message`) |
| A failed queue read never costs a frame | `readQueue` failing reads as "no siblings", so the new entry is queued normally. More traffic, never a loss |

**Fixed in review (#1887).** `inFlight` was ONE id while up to three lanes send at once, so the id
of the last lane to start overwrote the others. A message deleted while on the wire in another lane
was answered "never sent", and no `delete_message` went out. That is a defect of the
`cancelPending` body, older than this change. `inFlight` is now a set, and it holds a sent id until
its ROW is deleted: a withdrawal reading a sent row in that window was told "never sent". Three more
races in the same body, all older than this change and fixed with it:

- **The top-of-`flushOne` check is many awaits before the send** (health gate, `isGroupActive`, an
  upload). A withdrawal in between was answered "never sent", and the frame went out. The mark is
  re-checked with NO await before `inFlight` is claimed, so a send cannot start after a mark is set.
- **`flushOne` consumed the mark while the withdrawal's delete was pending.** A second pass of the
  lane re-read the still-present row, found no mark and sent it. The mark is now kept, and
  `pruneCancelled` drops it only once the row is gone AND no lane runs, since a running lane may hold
  the row in its snapshot. The `lanes.size` guard is pinned by a test that fails without it.
- **Marks leaked**: one per withdrawal, copied into every tab. A follower ignores
  `outbox_entry_cancelled` and drops its own marks, because it runs no lane and never prunes.

A latest-wins enqueue reads the queue ONCE, for the supersede, every withdrawal and the mirror. It
used to read it 2 + 2n times. **The one limit that leaves, accepted:** a row the leader sent and
deleted between that read and the withdrawal is reported `withdrawn: true`. Only a log line reads
that answer, and `max` makes the frame harmless. The supersede line says "before THIS tab sent it",
because a follower cannot see a leader's wire.

**Unread counters and #1820 (mark a community read).** The counter is
`countUnreadForUser(messages, myWatermark)`, which never counts an own message, so a mark that
excludes own messages counts exactly the same. #1820 moves a PRIVATE per-salon `clearedMarks` on the
server and never touches the read mark, the receipt effect or the MLS outbox. A salon has no MLS
group, so its marks cannot enter this queue (`flushOne` drops a `channel_` entry on sight).

**Rejected.**

- **Skip the checkpoint on the receiver (#1879).** Rejected by its review: the proof covered the
  manager, not `mls.bin`, which has three other writers, and it gained 4 %.
- **Hold the watermark until leave, background or the next send, with no other bound.** It is
  deterministic, but a DM peer would see "Vu" only once the reader left. A COUNT bound with K > 1
  delays the same receipt by K messages. Both change what a user sees, so neither was taken without
  the user. The 2 s debounce stays as the one coalescing clock. If it were wrong, the cost would be
  more traffic, never a lost receipt, because leave and off-screen now deliver. **Replacing it with a
  count is a decision owed to the user, see [open-questions](../open-questions.md).**
- **Supersede by deleting the old row first, then writing the new one.** A crash between the two
  loses both. Write-before-withdraw costs one duplicate frame in the same crash.
- **Rewrite the queued entry's proto in place.** The flusher may hold that entry in its snapshot, or
  have it on the wire. A row whose content changes under a running send is exactly the race
  `cancelled` + `inFlight` already settle for withdrawal, so withdrawal is reused rather than a
  second mechanism.
- **Infer a peer's read point from the messages they send, on the RECEIVER.** That changes every
  receiver and the stored watermark of every peer. Not sending the frame at all needs no receiver to
  change.

**A process death INSIDE the 2 s debounce no longer loses that window's frame (2026-10-17).** The
local mark was persisted, so the next open found nothing to announce. The mark is now OWED from the
instant it is decided (`recordDmReadMark`, the DM ledger of `salonReadMarkQueue.ts`), and dropped only
once the outbox has TAKEN the frame. Every outbox registration drains what is owed
(`drainOwedDmReadMarksOnOutbox`, subscribed in the root layout through `onOutboxRegistered`), so a
killed process's mark is queued at the next boot, whatever route it opens on. A conversation that
left the store before the debounce ended has its owed mark dropped. Test: `outbox.test.ts` ("a DM
mark owed by a killed process is queued when the next outbox is registered", failing without the
registration drain).

**What a phone should count** to confirm the gain: `[READ] ... has read up to` lines received, and
MLS checkpoints, per 3 minutes of a two-person DM exchange, on this build and on the one before it.
Expect the own-advance half to vanish, and the cold-start drains that held only watermarks to fall
by the same share.

### Scrollback below the window

To reach past its own window a device asks a peer for a **bounded range** rather than everything,
answered only within the floor. Same frame shape as a reconciliation answer, different trigger: a
user gesture instead of a connection. Without it, pruning on the browser would mean the browser can
never show the old past again.

**SHIPPED.** `requestOlderFromPeers` asks for the page immediately before the OLDEST message held -
the oldest, not the last rendered, because the list is not required to be sorted where the boundary
is read - and states its own `since`, which the answerer honours rather than recomputing. It refuses
to ask at all once what it holds already reaches its floor: there is nothing below it a peer is
entitled to send, so the frame would cost every member a decryption for an answer that must be
empty.

The trigger is **automatic, with the state made visible**: reaching the top of a conversation whose
local store is exhausted asks by itself, and the reader is shown a loading row while the ask is out
and a message when nobody was online to answer it. That distinction is the whole reason the function
returns `asked` / `no-peer` / `complete` / `unavailable` rather than a boolean - a silent nothing
would read as "there is no more history", which is a different statement and usually a false one.
The answer is recognised by the list reaching further back than it did when the ask went out, not by
a timer.

#### A group that BEGAN inside the window has nothing below it, and the messages cannot say so (2026-09-21)

The scrollback exists to reach **below** the device window by asking a member who kept more. A group
created **inside** that window has nothing below it: everything it ever held is inside the range
this device already claims completeness for, which belongs to the connection reconciliation, not to
this ask.

**The messages alone can never establish that**, and this is the part that made the defect
invisible. The oldest message a device holds is always strictly **after** the group was created, so
"I hold the first message this conversation ever had" and "I am missing years of past" are the same
shape at the boundary. A first contact therefore asked; the only other member was the person who had
just written and was no longer online; and the reader's first sight of a new correspondent was a
notice that no device could serve their history. Reported by the user, reproduced on an Android
handset on a group two minutes old.

**So the group's creation instant is carried, and it is the only thing that settles it.**
`dm_groups.createdAt` is a `@CreateDateColumn`, so it exists for every row ever written and never
moves; `getUserGroups` returns it, `ensureConversationForServerGroup` writes it onto the
conversation row, and the ask is refused when `startedAt >= since`. The comparison is against the
range start, **never** against the page boundary `before` - a comparison against `before` would
never fire, because the first message is by construction after the creation.

Three things about its shape, each of which was a way to get it wrong:

- **It is NOT the history floor.** The floor is shared, converged, monotone and merged as a `max`,
  so a wrong value can never be taken back. This is a local, fixed, server-stated fact about one
  group's row - never merged, never sent.
- **Absent means UNKNOWN, and unknown ASKS.** A client may be talking to a server that predates the
  field, and the safe direction is the one that costs a frame rather than the one that hides a past.
  `groupStartInstant` is the single place that reaches that verdict for a missing or unparseable
  value.
- **It is written as a REPAIR on the group sweep, not only on creation.** Every conversation stored
  before this shipped has no `startedAt`, and a device does not re-create rows it already holds - so
  a creation-only field would leave every existing conversation asking for an impossible past for
  ever. The sweep visits every active group on every connection, which makes it the one pass that
  reaches them all; it is write-once and silent.

`complete` is a fourth state rather than a reuse of `unavailable` although **both draw nothing**: one
says there is no past to fetch, the other says this device could not fetch it. They were one value
until this fix, which is where the defect started.

### The order of the startup walk, and why its LENGTH is not capped

Phase 2 of `restoreConversations` replays one conversation at a time - serialised, because the WASM
MLS client is not safe to invoke concurrently - so **the list returned by
`StorageBackend.getConversations` is the startup schedule**, not merely a set.

The interface promises "ordered by recency" and only one of its two implementations kept the
promise. `SqliteStorage` answers `ORDER BY updated_at DESC`; `IndexedDbStorage` returned `getAll()`,
which is key order - the conversation id, which is a group id, which is arbitrary - and its own
docblock said so. Each platform runs exactly one backend, so the two never met and nothing compared
them: the phone always replayed the newest conversation first and the browser replayed it wherever
its group id happened to fall. Fixed in the STORE rather than at the caller, since that is where the
promise is written, and pinned by `db/conversationOrder.test.ts` with ids ascending while timestamps
descend, so key order and recency order are exact opposites and no backend can pass by accident.

**THE LENGTH OF THE WALK IS A DIFFERENT QUESTION AND THE ANSWER IS NO.** Capping the pages replayed
per conversation per session - "stop after N, read the rest next time" - is safe for the CURSOR (it
only ever advances over rows actually walked) and unsafe for the MESSAGES, which is what matters:
groups are built with `max_past_epochs(2)` (`mls-core/src/group.rs`), so an application frame left
undecrypted while the group advances three epochs is **permanently undecryptable** -
`messaging.rs` has the branch that says so, and the loss it describes was measured on prod
2026-08-11. A cap would therefore trade a bounded amount of startup work for an unbounded risk of
losing somebody's message, which is the defect class of queue item 14, deliberately re-created.

What was actually costing the session was never the length of the walk:

- nineteen conversations each rebuilt the whole MLS client to decrypt nothing (fixed 2026-09-15, the
  session now opens on the first frame that needs it - see the subsection below);
- nineteen first pages were nineteen requests until `fetchHistoryBatch` made them
  `ceil(n / HISTORY_BATCH_MAX_GROUPS)`;
- and on an ordinary reload, with the cursor already at the head, each walk is one page, zero
  decrypts and zero ledger entries.

So the bound that was wanted already exists, and it is a bound on WORK rather than on COVERAGE: the
walk is bounded above by the head pinned at its first page, and below by the cursor. Anything cheaper
than that has to give up a message.

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
| D1 | ~~`saveMessage` is a full-row `put` and `toMessagePayload` omits absent fields, so every partial write **erases** the fields it does not carry. Six mutation handlers each pass a different subset - a reaction landing on a deleted message clears the tombstone; a read receipt on an edited message clears `isEdited`~~ **FIXED**: see [Persisting a mutation](#persisting-a-mutation) | `messagePayload.ts`, `types.ts`, both backends | yes |
| D2 | ~~The reading device never persists **its own** read state - the optimistic update is a bare `conversations.set`. After a reload, messages it read return as unread until a peer's bundle hands them back~~ **FIXED** as part of the watermark, which is the only place it could be fixed: see [Read state becomes a watermark](#read-state-becomes-a-watermark) | `MainChatPage.svelte`, `readState.ts` | audit |
| D3 | ~~Reaction removal never converges: a bundle's reactions are adopted only when the receiver holds none~~ **FIXED**: see [Reactions](#reactions) | `messageReactions.ts`, both merge sites | yes |
| D4 | ~~`editedAt` is not serialised into the bundle although `isEdited` is, so a device restored by bundle shows "edited" with no timestamp, permanently~~ **FIXED**: written by `serializeForBundle`, read by both merge paths and by the replay's row builder | `groupActions.ts`, `systemMessageHandler.ts`, `historySystemEvents.ts`, `history.ts` | audit |
| D5 | ~~Bundle merge flags `isDeleted` without replacing `content`, and writes the original text back to disk~~ **FIXED at rest**; dropping the shared-log entry is a separate decision, see [Deletion purges](#deletion-purges) | `systemMessageHandler.ts`, the bundle merge and its write | yes |
| D6 | ~~`serverTimestamp` is dropped on the live bundle add path, giving unstable ordering for messages sharing a client timestamp. The replay path preserves it~~ **FIXED**: carried onto the add path, matching the replay path | `systemMessageHandler.ts`, the `toAdd` mapping | audit |
| D7 | ~~The replay handlers for `reaction`, `read_receipt`, `delete_message`, `edit_message`, `remove_reaction` are unreachable for MLS groups, because those frames never enter the stream~~ **Inverted by the durability split**, then VERIFIED - and the verification found a hole the split had opened: see [Who may mutate on replay](#who-may-mutate-on-replay) | `historySystemEvents.ts`, `history.ts` | yes |

Three defects measured the same day are covered here rather than patched separately, by decision: the
stuck `isMessageCatchupActive` overlay, the post-ingest render freeze, and the 15 s `scheduleRetry`
loop that re-raises the overlay. **All three are FIXED**, and two of them turned out to be one:

- the **render freeze** was a pair of linear scans per ingested message - see
  [Also measured that day](#also-measured-that-day);
- the **15 s loop** was a clock standing in for a proof. The inbound handler leaves a frame in the
  server queue for exactly two reasons, both named in `unackedFrames.ts`, and neither is discharged
  by waiting: an unknown group needs its Welcome, an absent conversation needs the local store
  restore. Asking again every fifteen seconds re-fetched the same rows, failed them identically, and
  raised the catch-up overlay on every cycle - for the whole session, on a device whose group never
  came back. The ask is now driven by the EVENT that changes the answer
  (`refetchFramesLeftBehind`), fired where the Welcome is processed and where the restore finishes.
  No event, no ask, and nothing to bound;
- the **stuck overlay** was that loop seen from the outside: `showOverlay` is raised by any drain of
  more than one frame, and lowered in the drain's own `finally`, so a single cycle always ends. What
  never ended was the supply of cycles. Removing the clock removes it; no separate fix was needed,
  and inventing one would have been a second mechanism guarding a case that no longer occurs.

### Persisting a mutation

`IStorage.updateMessage(id, patch, deviceKeyB64)` is the only way to write a mutation of an existing
message. It reads the row by primary key, decrypts it, applies `mergeStoredMessage`, and writes it
back - the same read-modify-write `updateOutboxEntry` has always used, and the same cost in a
conversation of ten messages and one of ten thousand.

The merge rule is one sentence: **a key the patch does not carry is a key the handler knows nothing
about, so the stored value stands.** A key present as `undefined` counts as absent, because handlers
build patches by spreading optionals. Clearing stays expressible, but only deliberately - `[]`,
`false`, `0` - which is what an edit resetting `readBy`, or the removal of the last reaction, needs.
`id` and `conversationId` are dropped from any patch: the API is keyed by id, and a row that changed
conversation would vanish from both.

What this replaces: every handler used to rebuild the WHOLE row out of what it happened to know, and
`saveMessage` is a full-row replace, so the row's contents depended on which mutation touched it
last. Each patch now carries exactly what its own mutation changes - a receipt writes read state, a
reaction writes reactions, a deletion writes the tombstone and the replacement body.

A patch on a row that is not there yet is a no-op, where a full-row write used to CREATE the row.
That is the correct reading in the case it actually happens - a channel message, whose row is
deliberately not stored, no longer gets one conjured by a reaction - and in the remaining window (a
message buffered by a bulk ingest but not yet flushed to disk) the mutation is still applied in
memory and the row converges on the next reconciliation, which is what the rest of this page is for.

### Who may mutate on replay

Only the author of a message may edit or delete it. The live path has enforced that since
`f924932b`; **the replay path never did**, and until the durability split it did not matter, because
no `delete_message` or `edit_message` frame ever entered the shared log for anything to replay. The
split made those handlers reachable, and by doing so re-opened the hole one layer down: any member
could have written a deletion of any message in the group and had every device that later replayed
the log apply it.

The check is `replayMutationIsAuthorised(target, senderNorm, kind)`, and it runs at both places a
replayed mutation can land, because the two see different evidence:

- **in memory**, against the message already in the conversation, in `historySystemEvents.ts`;
- **after the batch save**, against the stored row, in `history.ts` - the frame may have arrived
  before the message it mutates, so the handler records WHO claimed it (`deletedMessages` and
  `editedMessages` are maps to `{ by }`, not sets) and the apply pass compares that to the row's real
  `senderId` once the row exists.

A refusal logs and records nothing, so a rejected frame cannot reach the DB pass through the
accumulator either. `historySystemEvents.test.ts` covers both directions; it is the module's first
test file, which is the reason a dead handler could go unnoticed for as long as it did.

The other half of the same question is on the server: `POST mls/send` took `senderId` from the body
and never compared it to the authenticated `x-user-id`, so a member could write frames into a group's
shared log under another member's name - and `senderId` is exactly what a replaying device
attributes a message, and every mutation in it, to. It now goes through the service's own
`assertRequesterMatchesCaller` (case-insensitive; skipped for an internal caller, which never crosses
nginx and has no header). The background twin `mls/push/send` was already sound: it authenticates the
claimed `userId` against that user's PushSecret before it becomes `senderId`.

Two writers stay on `saveMessage` on purpose, and neither is a mutation of accumulated state:
`persistSent` writes a message the device has just sent, under the LIVE conversation key, which a
patch cannot move a row to; and the FCM-preview upgrade replaces a placeholder with the real body.
Both now write back every field the in-memory message still carries, so neither erases anything
either.

### Everything the replay swallows, it logs

The twin of the outbox rule ([chat](../frontend/modules/chat.md#everything-the-outbox-swallows-it-logs)).
`replayHistory` is best-effort at every step that is not the decrypt itself - a localStorage quota or
a store read that fails must not abandon a page of decrypted messages - and that makes silence the
default failure mode of exactly the state the false-loss work depends on. Every one of those branches
carries a `[HISTORY]` warning naming what was lost, since 2026-08-16:

| Branch | What silence there costs |
|---|---|
| Retry counters unreadable / not persisted | The ladder restarts at zero, so a permanently undecryptable frame buys six more refetches per run |
| Seen-ciphertext set unreadable | Every archived frame is replayed as new - the shape a false loss has |
| Seen-ciphertext set not persisted | The same replay is repeated in full next time |
| Stream cursor not persisted | The next replay refetches from the previous cursor |
| Stale cursor not cleared | This run refetches from the start, the next one does not |
| Store unreadable for the cursor check | Proceeds on a cursor that points past a wiped store |
| Store unreadable before the batch write | An `isDeleted` / `isEdited` flag set by an already-seen event is overwritten with the original body |
| The post-save mutation pass | Replayed reactions, deletes and edits are not stored, and it says how many of each |

### And on the SERVER side, a `[HISTORY]` line names who asked

Every `[HISTORY]` and `[HISTORY_BATCH]` line opens with `user=<u> device=<d>` since 2026-09-16.
Before that it named the group, the cursor and the row count and nothing about the caller, which is
why the thirteen full `after=start` walks over one group in ten minutes measured on production that
day could be COUNTED and not ATTRIBUTED - not to a device, not to an account, not even to a number
of distinct callers. **A rate is only a defect once it is measured against the population that
produced it**, and a burst from one device retrying is a different system from the same burst spread
over an account's several devices.

**`until=` is what the caller asked, `head=` what the stream holds (2026-10-13).** The line used to
print the head it had just read as `until=` when the caller sent none, so a device already caught up
logged `after=X until=X entries=0` - read from a store phone's three launches (210 of 258 lines) as a
client asking for a window empty by construction. It was not: the batch catch-up sends only its
cursor, and "nothing after it" is the answer. The batch route now writes no line for a group whose
cursor IS the head and counts it in `[HISTORY_BATCH] ... caughtUp=N` instead; a caught-up group
still costs its `XRANGE` and `XREVRANGE`, and the client still asks, because nothing it holds says
the stream did not move while it was away. 85 groups ask in 2 requests (50 + 35), not 85.

**The two halves are not worth the same and the line says so.** `user` is what nginx put on the
request once `/internal/auth/verify` answered - a fact the service did not have to trust the caller
for. `device` is the client's own `X-Canari-Device`, self-asserted, accepted for the same reason
`probeSender` accepts the device half of an MLS identity: the user is authenticated alongside it, so
the most a liar can do is misattribute its own walk inside its own account.

**Where each half is attached.** The device id is known in exactly one place on the client, so it is
sent from exactly one place: `MlsDeliveryApi.auth()`, which every `/api/mls/*` request already goes
through - a call site that wanted it later would otherwise need its own plumbing. Nginx forwards it
untouched; the `/api/mls/` block only SETS `X-User-Id` and friends from the auth subrequest, and
client headers it does not name pass through. The header is already on a preflighted request
(`Authorization` forces one under Tauri's cross-origin webview) and NestJS reflects the requested
header list, so it costs no new round-trip.

**Nothing branches on it, and that is a property rather than an accident.** It reaches the log
through `sanitizeLogValue`, which cannot throw: a value the request DEPENDS on deserves a 400 naming
the field, but a field that only describes the request must never be able to refuse it. So there are
three readings and they are distinguishable - the value, `unstated` when the caller sent none (an
older client), and `invalid` when it sent something outside the safe allowlist, which is also what
stops a caller writing newlines into the log and forging lines in it. `device=pending` is a fourth
and it is real: the client's own literal for an unresolved identity, naming a request made before
`resolveDeviceId` finished.

---

---

## What disappears

Deleted outright, not deprecated. **All of it is gone** - a grep for each name below returns
nothing, which is the only form this claim may take:

- the durable awaiting-history registry **as a trigger** (`awaitingHistoryRegistry.ts`);
- the retry - the next state edge *is* the retry, so there is nothing to re-attempt;
- vouching, reason ranks, `isProvenAwaitingReason`, the 30-day give-up horizon;
- the 15-minute sweep (`AWAITING_SWEEP_INTERVAL_MS`) and `reSolicitAwaitingHistory`;
- the response-window store and the **"history pending" banner**. If a repair is needed and possible
  it happens silently; if no peer is online it does not happen, and there is no waiting state left to
  describe;
- the three-way `EmptyBundleMeaning` and the `vouched` flag it put on the wire: with silence as the
  fast path, an empty bundle no longer has to carry what it meant;
- the per-message `readBy` array, replaced by the watermark. The NAME survives one layer up, as a
  prop `MessageMetadata` receives, but it is now derived per render by `readersOf(msg, watermarks)`
  and nothing stores it.

What replaced the durable marker as a trigger is `historyReconcile.ts`, and it holds two notes, both
in memory and both about a MOMENT rather than a conversation: which groups the last attempt found
nobody online for, and which were asked within the last 30 s. Neither can outlive the session, which
is the property the marker lacked - it answered "is this conversation broken" from state whose
discharge condition was unreachable.

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
| Shape of a connection pass (2026-08-13) | **Elections concurrent, bounded at 6; sends still serialised** | Sequential: measured at 4.35 s for 9 groups, ~95 % of it serialised HTTP that takes no lock. Unbounded `Promise.all`: a device in fifty conversations opens fifty requests on the radio at reconnect |
| Announcing a drain (2026-08-13) | **Raised from the decrypted buffer, at 5 real messages** | `pendingCount` at drain start: it counts ciphertexts, and nothing can classify a frame before decrypting it - so a reconnect carrying nine probes and no messages announced a synchronisation for four seconds |
| Holding the socket through a short background | **Rejected** | The app would ACK over the WebSocket while backgrounded, cancelling the deferred FCM fallback, and nothing establishes the web `Notification` is delivered from a backgrounded WebView |
| **When a connection sweeps every group (2026-08-13, REVERSES "asking on every connection")** | **Only when the server could have dropped something**: no record of an earlier connection (new or restored store), or an absence at least as long as the server's 90-day retention. Otherwise no sweep at all - `connectionSweepDecision` | Unconditional, which is what shipped: cheap in frames and still wrong. Nine groups meant nine probes and their answers on a server carrying no other traffic, and the receiving side counts frames BEFORE decrypting them, so its own housekeeping read as an arriving backlog - a banner and a locked composer for two people talking. The three gaps were re-enumerated and only one needs a peer asked: a frame that could not be applied already triggers its own group (`handleUnreadableFrame`, `sawUnreadableFrame`) and is deliberately left unacked; a frame that never arrived is still in the server's queue and is redelivered; only a frame the server no longer holds needs a sweep, and nothing local witnesses that. **This is a heal, so it runs on evidence** |
| **An ask that cannot be attempted (2026-08-13)** | **Deferred with its blocker, never dropped** - one map keyed by group, holding `no-peer-online` or `no-probe-sender`, discharged by whichever edge lifts it (a peer returning, or the session installing its sender). One retry pass covers both: `retryDeferredReconciliations` | Dropping it with a log line, which is what shipped for `no-probe-sender`. **This is the fault that kept a production DM permanently broken** - see [A group that could not heal](#a-group-that-could-not-heal). Routing each reason to its own edge was also rejected: a group deferred under one reason and discharged only by the other's edge is exactly how this gap stayed open |

---

## A group that could not heal

Measured 2026-08-13 on a production DM (two members, epoch 6). It held frames MLS could never
decrypt, and every connection re-reported them without ever repairing anything. The digest design was
not at fault and was checked first: an undecryptable frame writes no row, so it correctly counts as
NOT held, and the diff would have named it.

The failure was upstream of the diff, in three steps that are individually correct:

1. `handleUnreadableFrame` (`setupMessageHandler.ts`) asks for the one repair that exists,
   `reconcileGroup`. Correct - the sender is the only party that can still produce the plaintext.
2. The frame is ACKed anyway (`return true`). Also correct: no redelivery can ever make a consumed
   generation decrypt, so leaving it queued would loop for ever.
3. `reconcileGroup` found `sendProbe === null` - the session installs it in `sessionAuth`, and
   inbound frames drain before that point - logged `no probe sender registered`, and **returned**.

Step 3 discards the request; step 2 destroys the evidence that would raise it again. Together they
lose the repair permanently, and the log line was the only trace. It was masked for as long as the
connection sweep was unconditional, because the next connection re-asked by accident; making the
sweep conditional (the row above) removed the accident and turned a hidden fault into a permanent
one. **The lesson is not about ordering:** moving the registration earlier would narrow the window
without closing it - a frame can arrive from a background push or a replay at any point - so the fix
is that a repair which cannot be attempted is REMEMBERED until it can be, and discharged by the event
that makes it possible.

### And the fix does not reach backwards - hence the audit

Measured on the device once the fix shipped: **the damaged group did not heal, and could not.** A
clean boot, three devices online, raised exactly one line - `no sweep - away 0 d, inside what the
server keeps` - and no unreadable frame arrived, so nothing asked. Holding a repair that is RAISED
cannot manufacture a trigger for damage whose evidence was consumed before the fix existed.

That is the general shape, not one group's bad luck. Every trigger this protocol has needs a live
witness - an unreadable frame, a replay that gave up, an absence past retention - and a conversation
damaged earlier has none of them left. What remains locally is an **absence**, and an absence is not
detectable from one side: nothing on the device records that a message it never read once existed.
The trace confirmed it end to end - for `secret-reuse` and `past-epoch-application` the durable
footprint is zero. No tombstone, no placeholder, no field in `StoredMessage` or `ConversationMeta`
able to represent a gap, and nothing rendered: the user sees an unbroken list with a hole in it.

**So the repair for pre-existing damage cannot be a cleanup - there is nothing to delete.** Deleting
and recreating the group is strictly worse: it destroys the messages still held and ends where a
comparison would have ended anyway. The only instrument that finds an absence is the comparison
itself, and what was missing was a REASON to run one.

**The one-shot audit** (`groupsOwingAudit` / `noteGroupsAudited`, `historyReconcile.ts`) is that
reason. `HISTORY_AUDIT_GENERATION` names the round; a device records which groups it has really
audited, and bumping the constant is the only way to run it again, deliberately and fleet-wide.

Two properties it is held to, both learnt above:

- **Discharged PER GROUP, and only for groups an ask actually left for.** `reconcileAllGroups`
  returns the asked ids rather than a count, and they are what gets written. Recording the pass's
  INPUT would discharge groups that were merely deferred - every member offline - and lose them for
  good, which is step 3 of the failure above wearing a different hat. Recording the OUTPUT means a
  group that could not be compared comes back alone on the next connection instead of dragging the
  whole store with it.
- **A group that can never be audited never owes it.** A distribution group (community seed
  carrier, private salon scope) leaves `reconcileGroup` through its one SILENT `false`, for ever, so
  the discharge above could never record one: a clean device logged `auditing 7 group(s) that never
  have been` then `0/7 group(s) asked in 0 ms` on every connection (PIN-9, 2026-09-05).
  `groupsOwingAudit` now takes `isDistributionGroup` as the predicate of what cannot be owed.
- **Idempotence from durable state, termination from a proof.** Nothing is scheduled and nothing
  fires on an interval. A group joined after the audit ran is indistinguishable from one deferred
  during it, and costs exactly one probe, once, ever - cheaper than a second durable record of when
  each group was joined.

What the audit does NOT do: it is not a guarantee. A group whose every peer is offline at each
connection stays owed, and is asked once per connection - one probe, for the one group that genuinely
needs it, which is the same honest limit the connection edge already has.

#### Measured on the fleet, 2026-08-13

Three real clients, on the shipped build. **The noise that had polluted every run stopped after the
audit's single pass**, which is the outcome the campaign needed:

| client | first connection | next connection | `SecretReuseError` before → after |
| --- | --- | --- | --- |
| A1 (phone) | `auditing 9 group(s)` → **8/9 asked** in 1140 ms | `auditing 1 group(s)` → 1/1 | 2 → 0 |
| W1 (browser) | `auditing 9 group(s)` → 9/9 in 276 ms | `every group already audited` | 18 → 0 |
| W2 (browser) | swept (new store) → 1/1 in 194 ms | `every group already audited` | 20 → 0 |

**A1's `8/9` is the per-group discharge proving itself, not a defect.** The ninth group had been
asked twelve seconds earlier by the deferral being discharged (`no probe sender yet - a577dba6…
deferred until one is installed`, then `asked` one second later - the `233c2e0b` fix running on
hardware for the first time). The coalescing window therefore skipped it, `reconcileGroup` returned
false, and it was **not** recorded as audited - so the next connection asked it alone, and the one
after that reported `every group already audited`. Recording the pass's input instead would have
discharged it silently.

The other measurement worth keeping: **9 groups in 276 ms on the browser and 1140 ms on the phone**,
against the 4.35 s the serialised pass used to cost.

#### That `→ 0` was true and did not last - the noise REGENERATES

Measured the same day, on W2, by reloading twice and reading the seen-cipher ledger across the pair
(2267 → 2271 entries):

| reload | `SecretReuseError` | `frame never read here and unreadable for good` | asks |
| --- | --- | --- | --- |
| 1 | 10 | **2** | 1 |
| 2 | 4, at an ADVANCING generation (263 → 266) | **0** | 0 |

Each frame is reported once and silenced for ever after - which is what the `→ 0` column above
actually measured. New ones appeared only where live traffic had been since, and that is the tell:
**the audit did not fail, it was cleaning up after a generator nobody had found yet.**

The generator was the invariant asserted at the `secret-reuse` / `past-epoch-application` branch of
`history.ts`: *"anything arriving HERE is a frame this device has never read - that is real loss"*.
It was false. `seenCipherHashes` was written by the replay ALONE. A frame delivered live, or drained
from the per-device queue, consumed its ratchet generation and left no mark, so the replay walked the
same archive row, could not decrypt what this device was displaying, and reported real loss. **Every
online device reconciled on its own ordinary traffic** - and the cost that matters is not the probes,
it is that a genuine loss became indistinguishable from this noise.

Why no identifier could be used, established before touching anything: an archive row is addressed by
its **Redis stream id** (`<ms>-<seq>`, from `XADD '*'`), a live envelope by `queuedMessageId`, a
**`queued_message` uuid**. Disjoint namespaces - and the server *awaits the `XADD` return value and
discards it* (`messaging.service.ts`), so the stream id is never stored, published or logged. What
the two paths do share is the **ciphertext**: `body.proto` is destructured once and the same string
is written to the stream and published in the envelope, with no transformer and no per-recipient
variation, and `mapHistoryEntries` hands it back to the client untouched.

So the mark is `frameFingerprint(bytes)`, written by `markHistoryFrameConsumed` from the one point
live delivery and the queue drain both pass through (`setupMessageHandler`, beside the existing
in-memory `noteFrameProcessed` - two ledgers, two lifetimes, two questions). The replay recognises it
before decoding anything and folds it into the stream-id key on first sight, so later replays answer
from the cheap check. Three properties it is held to are in
[durable-rules](../durable-rules.md): the key is the ciphertext, the set is ONE object shared with the
replay (which hydrates at its start and writes back at its end, and would otherwise erase the mark),
and the cursor advances by WALKING rather than jumping - a live frame's position written straight
into the cursor would carry it over an earlier frame the queue had already expired.

**The Android background decrypt deliberately does not mark.** It loads a throwaway copy of the state
and never writes `mls.bin` back (`src-tauri/src/mobile/background.rs`), so the foreground genuinely
does read that frame again from its queue; marking it there would skip a message nobody has read.

### The same generator came back through two paths nobody had counted (2026-09-07)

**The fix above was applied at ONE point and the docblock said so - "both call sites below reach
here", counting the two paths through `handleKnownGroup`.** Four other places in the tree hand bytes
to `processIncomingMessage`, and two of them spend a generation and record nothing:

- the **buffered-message replay** that runs when a Welcome lands (`setupMessageHandler`), applying
  frames held from before the join;
- **`attemptCommitReplay`**, re-applying the commits a device missed - and its own comment states
  that a commit consumes its generation exactly like a message does, which is why the live path
  marks commits too.

Both handle frames the shared archive also holds, so the generator this section describes was still
running, one class of frame smaller.

**THE MEASUREMENT IS WHAT ELIMINATED THE LEDGER AS THE SUSPECT**, and the suspicion was reasonable:
the durable write is a thunk the caller may skip, so "the session ended before the flush" explains
the symptom exactly. Read off W1's own `localStorage` on 2026-09-07, for the group TAB-3b uses:
**3 491 entries - 1 800 row keys and 1 691 frame fingerprints** - with the stream cursor PAST every
accused row, and `[WARN] History replay failed` nowhere in the run (it is `SEVERE` in the harness
now, so a run cannot hold it invisibly). A ledger that plainly works, missing exactly the frames
those two paths consumed: **not one accused fingerprint among 1 691.**

`noteFrameConsumed` in `history.ts` is the single gesture now - the durable mark and the in-memory
ring together, since every consumer needs both and a consumer that must remember two calls will make
one. `routeDistributionFrame` records as well: those frames are not what a conversation replay walks,
so it is insurance rather than a known fix, and the direction it can be wrong in is the safe one -
a recorded consumption can only ever prevent a false claim about bytes this device really did read.

**And the obligation is ASSERTED**, because "call this too" is what produced it twice.
`historyFrameConsumptionSeam.test.ts` enumerates every `.processIncomingMessage(` call site in
`src/lib` and fails unless each records or is named in an exemption list carrying the reason it must
not. The one exemption is the archive replay's own page decrypt, which records the whole page in one
pass and defers the write on purpose.

#### Verified on prod, 2026-08-13 - and the first measurement proved nothing

The fix is **prospective**: it marks frames as they are consumed, so it can say nothing about frames
already consumed by the bundle that shipped before it. The first reload after the deploy therefore
still reported 6 false losses, and that number is evidence for neither side. A measurement that
cannot come out differently under the two hypotheses is not a measurement.

What separates them is traffic consumed live **by the new bundle**. Three runs on W1, same probe
(`falseloss.mjs` / `falseloss-live.mjs` in the harness), build id asserted equal to the deployed one
each time:

| reload | traffic before it | false loss | `SecretReuseError` | asks |
| --- | --- | --- | --- | --- |
| 1 | live, on the OLD bundle | **6** | 12 | 1 |
| 2 (control) | none | 0 | 0 | 0 |
| 3 | live, on the NEW bundle | **0** | 0 | 0 |

Row 3 is the verdict, and row 1 is what makes it one: before the fix, live traffic between two
reloads regenerated the noise every time. The durable mark set grew 2172 → 2178 over the three
messages, so the deployed bundle is demonstrably running the marker rather than merely containing
it. Reconciliation stayed silent throughout (`no sweep - away 0 d, every group already audited`),
which is the property that was actually wanted: heavy, therefore exceptional.

The phone is checked the same way and separately, because it runs the assets baked into its APK and
no web result speaks for it (`falseloss-a1.mjs`). It needs BOTH halves, because writing the mark and
reading it are different code paths and only the second is ever seen: marks 2577 → 2583 → 2589 over
two rounds of live traffic, then a webview reload whose replay reported **0 false loss, 0
`SecretReuseError`, 0 asks**. "The phone carries the fix" on the mark alone would have been a claim
about storage, not about behaviour.

**Not attributed:** the marks grow by about two per message, not one. Consistent with the device also
consuming the non-application frames of the same exchange (typing, read watermarks), but unmeasured.
It cannot cause a false loss - marking more consumed frames can only prevent them - so it is recorded
rather than chased.

#### The ledger was ONE-WAY, and the false loss moved to the head of the stream

Measured 2026-08-13 (WP-FALSELOSS-2), on the MSG phase of the campaign. The fix above is correct and
stays; its `0` was measured over the direction it was written for and says nothing about the other
one. **Two paths consume ratchet generations on this device, and only one of them was telling the
other.**

| | writes | reads | so it can recognise |
| --- | --- | --- | --- |
| live delivery / queue drain | `frameFingerprint(bytes)`, durable + an in-memory ring | the ring only | a re-delivery, within this session |
| archive replay | the **stream id** of the row, durable | both keys | anything live delivery consumed |

The replay's own consumption was therefore invisible to live delivery in both key spaces: a stream id
is not something a live envelope can look itself up by - that is the whole reason the byte key exists
- and the in-memory ring is written only by live delivery and dies with the page.

So: a replay decrypts a row; the same frame arrives live a second later onto a spent generation;
`handleUnreadableFrame` looks in the one place it knew about, finds nothing, and files
`[MLS] LOST frame` plus a reconciliation - which answers `same state as <peer> - nothing to do`,
because nothing was lost. **The app proves it in its own record:** the MSG-1b row carrying the loss
also carries `copiesOnReceiver: 1` and `primerOnReceiver: 1`. A sender that had really rewound would
have produced a message no route could recover; every message was present.

That is also why it hit exactly three checks and no others - MSG-1b, MSG-5 and MSG-6 are the ones
that run a replay CONCURRENTLY with live traffic, and MSG-1b does it deliberately. The generations
complained about tracked the head of the stream (296, 340, 379, 438, 439) because the replay was
walking the head.

**The repair is the missing direction, and nothing else.** The replay marks the frame's BYTES the
moment a decrypt succeeds, and `handleUnreadableFrame` consults the durable set as well as the ring.
Two properties are load-bearing and each is pinned by a test:

- **the mark is taken on the SUCCESS path only.** A frame that failed to decrypt consumed nothing,
  and claiming it would tell live delivery "already read" about a frame nobody has read - which
  silences the one signal that raises a repair. The give-up branches still mark the ROW, so the
  replay does not walk it forever, and never the bytes;
- **the trigger is untouched.** A frame whose bytes are in neither ledger still logs the loss and
  still reconciles. This is not a suppression, it is the evidence the decision was missing - and the
  rule it belongs to is in [durable-rules](../durable-rules.md).

The residual, accepted: the byte key is a 32-bit FNV-1a plus the length, so a collision inside one
group's 5 000-entry set could silence a real loss. The replay has leaned on that key since
WP-FALSELOSS-1 and this changes the exposure by a constant, not by an order.

##### The direction was right and the PLACE was wrong - a batch spends in one call and reported in another

Measured 2026-08-14, on the deployed fix above. The false loss did not go away, and the run that
found it is the reason the shape is now certain: `msg1 --cold` followed by `msg1b` reproduced it
**every single time**, which turns an intermittent-looking fault into an experiment.

`session.decryptPage(...)` consumes the ratchet for an ENTIRE page in one call. The marks, however,
were written by the loop that runs afterwards - the one that decodes each frame, builds its envelope,
pushes it to the chat and awaits. Between the two there is a window, seconds wide on a real page, in
which every generation of that page is spent and the ledger says nothing about any of them. A frame
arriving live inside that window looks itself up, finds nothing, and is filed as a loss.

**The proof is a pair from one page**, and it is what makes the diagnosis certain rather than
plausible:

```
00:37:58  Ciphertext generation out of bounds 520 -> [MLS] LOST frame -> reconciling
00:38:01  Ciphertext generation out of bounds 521 -> [MLS] Duplicate delivery (already read by the archive replay)
```

Same group, same epoch, same page, three seconds apart: 521 was recognised because the loop had by
then reached it, and 520 was not because it had not. Nothing about the two frames differs except when
the loop got to them - which is precisely the definition of a window rather than a defect in the
recognition itself.

**The repair is a move, not a new mechanism.** Every successfully decrypted frame of a page is marked
immediately after `decryptPage` returns, before any of them is processed; the per-frame loop keeps
only the stream-id write, which answers the different question of where the walk has got to. The
success-only property is unchanged and still pinned by a test, and two more cases pin the page
behaviour: a two-frame page marks both, and a page where one entry failed marks only the other.

The rule this taught - *a ledger is written where the effect lands, not where the results are
convenient to iterate* - is in [durable-rules](../durable-rules.md).

##### That fix works, and it did NOT end the false loss - one frame per run still refuses on both paths

Measured 2026-08-14 on the deployed batch fix, full MSG phase, three clients each proven to be on the
built code first. **12 PASS, 1 PASS-DIRTY**, the single dirty row being MSG-1b - and the tail from
W2 is worth reading in full, because it says two things at once:

```
23:44  Ciphertext generation out of bounds 555 -> [MLS] Duplicate delivery (already read by the archive replay)
24:29  Ciphertext generation out of bounds 559 -> [MLS] LOST frame -> reconciling
24:31  Ciphertext generation out of bounds 559 -> [History] frame never read here and unreadable for good
24:33  Ciphertext generation out of bounds 560 -> [MLS] Duplicate delivery (already read by the archive replay)
```

**555 and 560 are the batch fix working**: both took the branch that used to say `LOST frame`, and
both now resolve to a silent ACK. That is the mechanism above, confirmed on live traffic rather than
argued from the diff.

**559 is a different thing and must not be filed under the same cause.** It is refused by BOTH
consumers - live delivery at 24:29, the archive replay at 24:31 - and NEITHER ledger holds it. Since
those are the only two MLS consumers in the client (`noteFrameProcessed` has exactly one call site,
`markHistoryFrameConsumed` two, and the channel path is AES, not MLS), a generation spent with no
mark anywhere means the bytes that spent it are not the bytes being refused.

Nothing is actually lost, and the app proves that itself: `copiesOnReceiver: 1`, `lostAgainMs: null`,
and the reconciliation it triggers answers `same state as <peer> - nothing to do`. The cost is a
wasted round trip and a `severe` line that makes a green run unclean.

**What the log could not say, and now says.** Two causes produce this and the generation number is
identical in both - a frame consumed here without being recorded (ours), or two different ciphertexts
genuinely sent at one generation (the sender's ratchet rewound, theirs). Answering it required a live
console tail on the right browser at the right second, which no later reader and no user can go back
and take. The frame's fingerprint is now printed on all three lines - the duplicate, the `LOST frame`
and the `[History]` one - so a plain log read settles it: **the same value on two lines is a ledger
gap, two values at one generation is reuse.** Pinned by a test, because it reads as decoration.

Two hypotheses were RAISED AND REFUTED here rather than carried forward, and both refutations were
cheap: the ledger write is a `queueMicrotask`, not a timer, so a reload cannot outrun it; and
`msg1 --cold` - the only reliable trigger - merely skips a warm-up send, so "the sender reloaded and
its checkpoint was behind" cannot be the mechanism.

##### What the fingerprints exposed on their first run - the same defect, in the READ direction

The instrumentation paid for itself immediately, and not by answering the question it was written
for. Three consecutive `msg1 --cold` + `msg1b` pairs, and every one printed this shape:

```
[MLS]     LOST frame ... (SecretReuseError, frame 5p:9redaw)
[History] frame never read here and unreadable for good (secret-reuse); ... frame 1786665504640-0
```

Those are not the same kind of thing. `5p:9redaw` is a fingerprint of the ciphertext;
`1786665504640-0` is a **Redis stream id**. The replay was printing - and keying on - a variable named
`cipherFingerprint` that held `msg.id`. **A name that lied is what let two key spaces read as one**,
in the log and in the reader's head. It is `rowKey` now, and the loss line carries both.

That made the real defect visible, and it is the mirror of the one directly above. The replay
assembles a page by checking each row against `seenCipherHashes`, and only THEN calls `decryptPage`.
Live delivery can read one of those frames in between. The comment that used to sit on the failure
branch reasoned from the earlier answer - *"a frame already read is skipped before ever reaching the
decrypt, so anything arriving HERE is a frame this device has never read"* - which quietly assumed
the two moments were one. The check now re-asks at the moment the verdict is formed, which costs one
hash of bytes already in hand and only on a frame that has just failed.

**The batch fix wrote the ledger where iterating was convenient instead of where the spending
happened; this one READ it where the work was queued instead of where the verdict is formed.** One
rule, two directions, and the second was invisible until the first was fixed.

This addresses the REPLAY side only. The live path already consults both ledgers inside its own catch
- its timing was never wrong - so whether `[MLS] LOST frame` also stops is an open measurement, not a
claim. If it persists, a consumer this client does not account for is spending the generation, and
the two lines are now comparable for the first time: same fingerprint on both is a ledger gap, two
fingerprints at one generation is genuine sender-side reuse.

##### WP-DUPDELIVERY-1 - the ledger was the witness, and the overlap was one await wide

Everything above makes the two consumers RECOGNISE each other. None of it stops them meeting, and
the logs said so in a way that is easy to miss: across every capture, **every single
`Duplicate delivery` line names `already read by the archive replay`, and not one names live
delivery.** A reconciliation whose other arm has never once fired is not a reconciliation, it is a
one-directional heal standing over a real ordering hole. **A race that heals cleanly is still a
defect** - if the mechanism needs a heal in theory, the mechanism is wrong, whatever it does in
practice.

Two ends have to be closed for the walk and the queue to be disjoint by construction:

- **Above the head:** a frame sent after the pin has its row out of the walk's range, so the queue
  owns it alone. Shipped 2026-08-14 as `HistoryPage.head`.
- **Below the head:** a frame sent before the pin has a row in range AND a queued copy, so the
  mailbox has to be empty before any row is processed - live delivery marks the frame, and the
  fingerprint check skips the row.

Both existed. **The order between them was wrong, and the barrier did not do what its own docblock
claimed.**

`waitForMessageQueueIdle` was `await pendingPullInFlight` then `waitUntilIdle()`. That answers *has
the pull that is RUNNING finished* - which, with no pull running and a full mailbox on the server,
is instantly yes. Captured on prod 2026-08-15: a replay finished at `11:43:10`, a pull started at
`11:43:12.889` on a connection edge, and the one row it returned was a frame the replay had already
read. The barrier now PULLS when nothing else has, and its evidence for "empty" is a **completed
pull plus a socket still open** (`mailboxEmptiedByAPull`) - a fact about a finished operation, never
a duration. A pull that died half-way leaves it false.

And the barrier ran BEFORE the first page was fetched, so the head was pinned *after* it. That left
exactly the frames sent between "mailbox empty" and "head pinned" - one HTTP round trip - in both
sets. The barrier now runs after the first page lands and before any row is touched: pin, empty,
read. Fetching first costs nothing, because a page whose frames the drain delivered meanwhile is
skipped row by row rather than re-decrypted.

###### The first attempt at that order deadlocked the client, and where the barrier may be taken is part of the order

Shipped as `4604eda5`, the barrier moved one await too far: it landed inside the walk loop, which is
**after `createDecryptSession`**. Opening a decrypt session opens a catch-up, and a catch-up holds
the global MLS mutex for its whole life, while the drain needs that same non-reentrant mutex for
every message. The walk therefore waited for a drain that could not start.

Caught by MSG-1b on the first pass of the verification run, 2026-08-15, and the two sides of the log
agree frame for frame:

| Where | What it showed |
| --- | --- |
| W2 console | `Disk writes deferred (bulk ingest depth=1)` at `14:58:44.612`, the frame at `14:58:45.001`, its drain nesting to `depth=2` - then no `Processing message`, no `Drain complete`, no `Bulk ingest done`, ever |
| The check | `copiesOnReceiver: 0`, and `NOT IN THE STORE EITHER` after a scroll and a reopen |
| chat-delivery | the same two frames unACKed -> `PUSH_DEFERRED ... -> FCM fallback`, then `No push token for user=... device=web-...` - it is a browser |
| The rig | W2 read **OFFLINE** for the rest of the run, so all 12 scripts of passes 2-5 were BLOCKED rather than given verdicts |

It does not heal: the client stayed wedged until it was reloaded. **The order was right and the
placement was wrong** - and both facts can be established with the mutex free, because pinning the
head is one HTTP read that touches no MLS state and emptying the mailbox *is* letting the drain have
the mutex. So the sequence is **pin, empty, open, read**, with the first two above the session -
and since 2026-09-15 the open moved DOWN again, past the read, to the first frame that needs it (the
subsection two below).

Two things came out of it that outlive the fix. The hazard was **already named in this codebase**,
at `answerAfterMailboxDrained`, for the responder legs - which solve it the other way, by deferring
past the drain instead of awaiting it. And `waitForMessageQueueIdle` is now the place that states
the fact rather than discovers it: it is the only code that can see `catchUpDepth > 0` at the moment
of the call, so it logs an error naming the call site's mistake and returns, turning an
unrecoverable hang into a defect report.

**The heal stays.** It is the witness that says whether the overlap is really gone, and it is what
covers a consumer this client does not account for. What changes is that reaching it is now a
finding rather than the normal path - so a `Duplicate delivery` line in any later capture is a
defect report, and its arm finally distinguishes two causes that can both occur.

###### And the session is opened by a frame, not by the walk - "pin, empty, read, and open only if there is anything to open"

`createDecryptSession` is not a handle. On the web client it takes `save_state(undefined)` of the
WHOLE MLS client, ships that snapshot to a freshly spawned worker and has the worker rebuild the
entire client before the first page is offered; `finish` reads the advanced state back and reinstalls
it. Measured on the web client 2026-09-15: **6 694 960 B per snapshot**, and a reload replays every
conversation - **19 of them, ~127 MB** of serialise / transfer / rebuild before the first message is
on screen.

**None of it decrypted anything.** The walk's first act on every row is to ask whether the row is
already accounted for - the seen-ciphertext set, this device's own `sender_device_id`, the frame
fingerprint left by live delivery - and on a reload at the head there is nothing left. So the cost
was paid for the POSSIBILITY of work, on the path where there is none.

The session is therefore opened on the first frame that actually has to be decrypted
(`session ??= await mlsService.createDecryptSession(id)`, immediately above the `decryptPage` call),
and `session?.finish()` in the outer `finally` is unchanged - a walk that opened one still commits
its ratchet exactly once, a walk that never needed one never takes the MLS mutex at all, which also
lets live delivery keep draining while the archive is being paged.

**This cannot move the barrier.** Pinning the head and emptying the mailbox stay where the deadlock
above put them, above the loop with the mutex free; opening LATER than they do is the direction that
was always safe. The disjointness argument is untouched: nothing above the pinned head is walked, and
nothing below it is still in the mailbox when a row is processed.

###### The barrier also PULLS, and at boot it was reachable before anything could drain what it pulled

The second attempt was correct in its ordering and still stopped a client dead - this time on the
**startup** path, and for a reason that has nothing to do with the mutex.

`waitForMessageQueueIdle` does not only wait. When no pull has happened it *fetches* the delivery
queue, which is the half that closed WP-DUPDELIVERY-1. `processQueue` returns at its first line while
`messageCallback` is unset. In `sessionAuth`, `setupMessageHandler` - which sets that callback - sat
**after** `loadAndRestoreConversations`, and the restore drives the archive replay, which takes this
barrier. So on a device with anything queued server-side, boot went: replay → barrier → pull → frames
enqueued → nothing can drain them → `waitUntilIdle` waits on a queue it has just filled itself.

Found on 2026-08-15 while restoring the clients for the re-run, and the A/B is complete:

| | W1 | W2 |
| --- | --- | --- |
| Bundle | `__sveltekit_1yypc8t` | `__sveltekit_1yypc8t` (identical) |
| Server-side queue | 0 rows | **2 rows**, `12:58:45.088` and `12:58:47.077` - the deadlock's residue |
| Boot | `[TAB] Leadership acquired` at 2 s, socket at 2.5 s, `[WS] Connected to Chat Gateway` | last line at 1 s, then **silence**; no leadership, no `Connecting to Gateway…`, no socket created at all |
| Gateway presence | `ONLINE` | `OFFLINE`, on every reload |

The backlog alone decided it. Nothing recovers it either: the frames stay queued because the device
that would ACK them never connects, so every subsequent start reproduces it exactly. The only visible
trace was `[QUEUE] messageCallback not set` at `console.warn`, twice - which reads as a notice.

**The fix is the order, and deliberately not the guard.** The inbound pipeline is registered before
anything can pull, so the boot pull drains normally and WP-DUPDELIVERY-1 stays closed *at boot*,
which is where it matters most. Refusing to pull instead would have traded a permanent hang for a
duplicate-delivery window on every startup.

The guard is still owed, for the same reason as the `catchUpDepth` one above: the barrier is the only
code that can see the fact at the moment of the call. It logs an error naming the call site's mistake
and returns - skipping is strictly better than hanging, because a duplicate is caught by the shared
fingerprint ledger and a client that never connects again is caught by nobody. And `processQueue`'s
own branch is now an error that names the consequence rather than the condition.

###### And the guard's first sighting on prod was a real one - the replay trigger asked from inside its own session

The `catchUpDepth` guard fired once during MSG ×5 on `1647f10a`: **W1, pass 1 of 5, the only pass that
followed a boot.** It is not a false positive, and it is not new - the guard is, which is why it had
never been seen.

`replayConversationHistory` raises `void reconcileGroup(...)` when the walk meets a frame it can never
read, under a comment reading *"once, now that the whole page has been walked and the store is
settled"*. `session.finish()` runs in that function's `finally`, i.e. **after**, so the catch-up still
held the global MLS mutex. `reconcileGroup`'s first act is the mailbox barrier, the drain needs that
same mutex - and `void` defers nothing: the microtask runs roughly a full replay before `finish`.

The consequence is not the log line. The barrier refused, so **the ask went out against a mailbox that
had never been emptied** - the exact ordering guarantee that barrier carries, and the reason it lives
inside `reconcileGroup` rather than at the connection edge (see the section above: it is the one door
every trigger comes through). An ask raised against a difference the device was about to close by
itself is the routine case reconciliation must never become.

The trigger now fires from the `finally`, after `await session?.finish()` - so it also fires when the
walk threw, which is correct: the unreadable frame was seen either way. Pinned by an ORDERING test
against a gated `finish` (`history.consumedFrames.test.ts`), because asserting the ask *happened*
passes against the defect too; run against the old placement it fails with `Number of calls: 1`.

**And the report now names its caller.** `catchUpDepth` is a global: it can say a session is open,
never whose. A caller nested inside one deadlocks, a caller merely running beside one would only wait,
and both were refused with the same sentence - so `waitForMessageQueueIdle(caller)` takes a label at
all seven call sites (`archive replay`, `history ask`, `history answer`, `history request answer`,
`outbox flush`, `connection sync`, `media send`) and both refusals quote it. Attributing this one
without it cost a read of every call site.

###### And the guard was refusing six callers it should have WAITED for - fixed 2026-08-16

The label was the whole fix for the report and NO fix at all for the behaviour, which is the more
expensive half. `catchUpDepth > 0` refused **every** caller, and only one of them is a deadlock.

- **The caller is inside the session it would be waiting on.** The stack that would close that session
  is the one blocked here, so nothing can ever release it. Refuse, and say so - this is the W2 wedge
  of 2026-08-15 and the `reconcileGroup` sighting above.
- **The session belongs to somebody else.** The global mutex blocks the drain either way, but by a
  stack that finishes on its own. **The barrier resolves - later.** Waiting longer is precisely what
  the caller asked for; refusing hands it the one outcome it was written to prevent.

The second case is not hypothetical and did not stay unobserved for long: **MUT-2, 2026-08-16, on
prod.** A replay opened a session on `642f389a…`; 98 ms later `connection sync` and 99 ms later
`outbox flush` were both refused, neither being about that group. `outbox flush` then proceeded to
send - the comment at that call site names the consequence exactly, *"sending at a possibly stale
epoch"*, the silent-loss race the barrier exists to close. One connection edge, both halves of the
ordering guarantee dropped, and the only trace was the diagnostic line added the day before.

**The discriminator is now a parameter**, `waitForMessageQueueIdle(caller, catchUpGroupId)`, and it is
NOT "which group this call is about" - it is *"the group whose session this stack could be running
inside"*. `archive replay` passes its group and `history ask` passes `groupId`; the other five pass
`null`, each being a connection edge, a click, or a leg already deferred past the drain by
`answerAfterMailboxDrained`, none of which can be inside a session. A same-group session is still
refused even when the caller does not own it: the group is a proxy for "inside", not a proof, and the
asymmetry is deliberate - a wrong refusal costs a guarantee the shared-fingerprint ledger still
catches, a wrong wait costs the client until it is reloaded.

**The day it spent as prose is the lesson**, and it is rule 15 of
[testing-methodology](../testing-methodology.md): the label was matched against the open group ids
with `caller.includes(...)`, and **not one of the seven call sites spells a group id**, so `NESTED`
could not be printed in the field at all. Every real occurrence read `CONCURRENT` - including the
nesting the guard exists for, which would have read as "nothing to fix". A distinction carried in a
string is a distinction nobody makes.

### The seen-ciphertext ledger has two namespaces and two bounds (2026-10-08)

`history_seen_cipher:<user>:<group>` is ONE array holding two kinds of entry that answer different
questions: a **fingerprint** (`frameFingerprint`, `<len36>:<hash36>`: *"I consumed this ratchet
generation"*) and a **row key** (a Redis stream id `<ms>-<seq>`: *"I walked this row"*). Losing a
fingerprint is what a false `unreadable for good` accusation is made of; losing a row key costs a
re-check against the fingerprints.

**What was measured (TAB-3b, 2026-09-08, `seenset.mjs`, W1 bench profile).** The busiest conversation
held 2 762 row keys and 2 073 fingerprints, under the old SHARED cap of 5 000 that kept the last
5 000 of the mixture - so row keys pushed fingerprints out first. Across the profile: 169 ledgers,
247 kB, mean 1.5 kB each, and nothing bounded their number.

**What bounds it now** (`frontend/src/lib/utils/chat/seenLedgerBounds.ts`, called by
`saveSeenCipherHashes`):

| Bound | Value | Why this number |
| --- | --- | --- |
| Fingerprints per ledger | 5 000 | busiest measured 2 073, 2.4x headroom |
| Row keys per ledger | 5 000 | busiest measured 2 762, 1.8x headroom |
| Ledgers per user | 256 | 169 measured, 1.5x headroom |

Each namespace keeps its LAST N in insertion order, so the oldest of the overflowing namespace goes
first and the other is untouched. The caps were not lowered below the old ceiling per namespace on
purpose: shrinking one evicts a mark, and a mark's loss is the accusation. Worst case per ledger is
about 5 000 x (14 + 18) characters (~160 kB); 256 full ledgers would be far past a 5-10 MB origin
quota, but the measured mean is 1.5 kB and a write that does not fit is still caught and logged, so
the number protects against unbounded growth, not against a profile that fills every ledger.

**The ledger cap is write order, not a clock.** A per-user index `history_seen_cipher_index:<user>`
lists groups oldest write first; a write moves its group to the end, and past 256 the front entries
are deleted (storage key, in-memory cache, pending flush) with one `[HISTORY]` warning. The group
being written is never evicted. A profile with no index adopts its existing ledger keys once, in
storage order, so the first eviction after the upgrade is arbitrary among them; an evicted group
re-walks its archive once. Fingerprint versus row key is told by shape (a stream id has a dash and no
colon); the id-less fallback row key (`<ts>:<content>`) is longer and non-base-36, so it counts as a
row key. Pinned by `seenLedgerBounds.test.ts`.

**Not done, deliberately:** the mark/advance atomicity and the 61 s catch-up are separate open items
in [backlog](../backlog.md).

---

## A cold start re-accuses frames it already read: the mark must be one write with the advance (TAB-3b, measured 2026-09-08)

Shipped and in `CHANGELOG.md`: the two silent decrypt paths that spent a generation without recording it
(`noteFrameConsumed`, asserted by `historyFrameConsumptionSeam.test.ts`), the checkpoint-bound replay marks
(`commitPendingHistoryMarks`) and the ack barrier (`announceAck` / `ackInFlight`). Run-by-run evidence is on
the TAB-3b row of [cross-client-testing](../cross-client-testing.md).

**What is left, measured 2026-09-08 with the cap and hydration both exonerated (`seenset.mjs`).** Each
TAB-3b cold start still prints `[History] frame never read here and unreadable for good (secret-reuse)` for
frames the device already decrypted, re-accuses every earlier one (three generations more per start, so the
cost is QUADRATIC in cold starts) and fires a full `[HISTORY_RECONCILE]`. The accused fingerprints are
ABSENT from every ledger on the client while the frame no longer decrypts (`SecretReuseError` at its own
epoch): **the advance IS durable and the mark is NOT.**

**The fix is atomicity, not ordering, and no smaller fix should be attempted.** Writing the mark eagerly is
right for a ROW key ("I walked this row" has no ratchet to run ahead of) and the OPPOSITE defect for a
FINGERPRINT: one written before its advance is durable tells the next replay to SKIP a frame nobody read - a
silent real loss, strictly worse than a false accusation. The mark and the advance are one fact and must be
one write: the mark belongs INSIDE the checkpoint, or "have I already consumed this ciphertext" should be
answered FROM the MLS state rather than from a parallel ledger that can disagree with it.

**The live half followed on 2026-10-17** (draft PR `perf/pk13-message-storage`): `markHistoryFrameConsumed`
no longer writes on its own microtask, it registers with the same checkpoint-bound marks as the replay, so
EVERY fingerprint now becomes durable with the checkpoint holding its advance and never before it. Found
through cost rather than correctness - a drain awaits between frames, so the microtask re-stringified the
whole set per frame ([performance-audit](../frontend/performance-audit-2026-10-12.md#findings-5-9-and-10---built-2026-10-17-draft-pr-perfpk13-message-storage)).
One path still writes `mls.bin` outside `persistCheckpoint` - Tauri's `live-ahead` resume persist - and
leaves its marks for the next checkpoint: the survivable direction, a re-accusation if killed in between.

**Still unmeasured**: which path spends the generations - live delivery, the queue drain, or the archive
replay's own successful pages. A console tailer cannot answer it (the row destroys the CDP target it would
attach to); it needs a purpose-built reproduction that brings W1 down between a known send and a known
decrypt.

**The catch-up is a TIMER, worth a row of its own.** Five cold starts took 61 863 to 62 019 ms to show a
message sent while the browser was down (a 156 ms spread): something waits about sixty seconds before an
offline device is given a message the server already holds. `PHASE_STUCK_MS` is 60 s but only REPORTS, so
it is not that. On a phone this is a minute of an empty conversation.

## HEAL-repair lands on a coin flip: the measurement and the root cause (2026-09-08)

The open line is in [backlog](../backlog.md#p1---the-repair-of-a-rewound-sender-lands-on-a-coin-flip-the-ask-cadence-is-identical-either-way-and-a-peer-21-messages-behind-was-told-same-state---nothing-to-do-measured-2026-09-08-ten-runs-across-three-builds). The row HEAL-repair and its `PASS` of 2026-09-06 were one draw of a three-sided coin (ten runs across three builds, 2026-09-08). Two candidate causes were refuted by A/B and are not to be re-opened without new evidence ([durable-rules](../durable-rules.md)).

**What separates a healed run from a partial one is not the asking.** The cadence is identical: three asks about 33 s apart, `escalated: true` every time. The difference is whether any one is ANSWERED. Every PARTIAL run contains zero `[HISTORY_BUNDLE]` lines; every HEALED run contains exactly one, answering the LAST ask (172 ms after it in the sampled run), never the first.

**The state-key leg has been wrong at least once.** On the healed run of 01:07 the responder logged `same state as <W1> - nothing to do` and a digest found 21 missing messages 267 ms later. Both keys are computed over the ASKER'S window (`historyStateKeyFor(groupId, probe.since)`), so the two devices were not measuring different spans; the stale-cache explanation is excluded (`invalidateHistoryStateKey` is called on every write path of both backends). Not excluded, and where to look first: `historyRangeStartFor`, and whether an empty or clipped span makes two different stores hash alike. **The same defect is why TAB-3b is `PASS-DIRTY`**: W1 reports the same two frames (group `2bd5add9`, `7e:4yhgc8` and `5p:1s1iuic`) as `never read here and unreadable for good (secret-reuse); will reconcile` on reload after reload, a reconciliation promised four times and never done.

**Root cause: arithmetic.** The server elects a RANDOM online member. Over the A/B window the twenty history requests were routed 10 to W3 (same user as W1, real and active, 5 groups, idle `0d`), 7 to W1 (the ONLY device holding the messages) and 3 to W2 (W1's own asks). Three candidate responders, one holder: the run heals only when one draws W1, about a third of the time. W3 cannot help for a good reason: the rewind is on W1's SENDER ratchet, so every receiver fails those frames identically.

**And the walk terminates on a false proof.** In `actions.ts`, state leg: when `ourKey === probe.key` the responder logs `same state - nothing to do` and answers with its COVERAGE. Adequate coverage is signalled by SILENCE ("a member whose coverage turns out to be adequate simply says nothing"), so the asker reads *we agree, and this member is complete* and stops. Both halves are individually right; the defect is the INFERENCE. The comment above that branch already says AGREEMENT IS NOT COMPLETENESS but addresses only the window case, never two peers agreeing while a THIRD member holds what both lack.

**The rule that makes it fixable**: the asker holds POSITIVE PROOF that it is incomplete (frames it has and cannot read - the evidence `escalateReconciliation` is already gated on), so *a peer's agreement is not a termination while this device holds frames it cannot read; it is a reason to EXCLUDE that peer and elect another*. That drives the exclusion walk from an ANSWER rather than from an absence, the only safe form - the 2026-09-08 attempt that drove it from an absence excluded W1 200 ms after electing it. [durable-rules](../durable-rules.md) already says a deadline is not a termination proof, and a leg that needs no remembered state to answer must not require a live waiter.

**Not built, deliberately**: three earlier attempts to carry "this group is incomplete" across an exchange were each wrong in a different way (a durable marker read as "have I already asked", a coalescing clock, an absence read as silence). This one needs its state specified first: WHAT is remembered, for HOW LONG, and WHAT discharges it - the discharge being the repair landing, never any peer saying anything.

## Open questions

**None are open.** Two were closed on 2026-08-12 and moved into [Decisions](#decisions-taken) - what
may move the floor (nothing, for now) and who chooses the window (the platform, not the user) - and
the three below were closed by measurement or by decision. They are kept struck through rather than
deleted because each records why an alternative was rejected, which is the part a later reader needs.

- ~~**The new cap.**~~ **DONE.** The order was respected: Redis persisted → `maxmemory` 1→2 GB →
  `HISTORY_STREAM_MAXLEN` 1000→8000 (`retention.constants.ts`). Worth re-deriving rather than
  re-deciding if the mutation budget turns out differently: the cap is per group and `maxmemory` is
  for the whole store, so raising the per-group cap first would let eviction choose which
  conversations keep a shared copy at all.
- ~~**State key cost at scale.**~~ **MEASURED 2026-08-12, not a problem.** Off production:
  `dm_group_members` holds 41 memberships over 23 users and 21 groups - a median of ONE conversation
  per user, a maximum of 8, plus at most 9 channels for the busiest account. The fan-out is one
  small frame times seventeen in the worst case that exists today, and it would take two orders of
  magnitude of growth before the *frame count* mattered. Re-measure with that same `GROUP BY` if the
  population changes shape; what is worth watching is not the frames but the WALK behind each key
  (see below).
- ~~**Whether a deletion must also drop the shared-log entry.**~~ **CLOSED 2026-08-12: leave it as
  it is**, and the reason is that correctness never depended on it. The `delete_message` mutation is
  itself an entry in the shared log, so any device replaying that log converges on the tombstone
  whether or not the original entry is still there. What remains is a retention question and not a
  convergence one: the original ciphertext of a deleted message sits in the stream until the cap or
  the TTL evicts it, alongside every other message of that conversation, and buying its removal
  would mean either rewriting a Redis stream in place or teaching every reader to skip entries a
  later entry cancels - two mechanisms, both permanent, for a window that closes on its own.
  Re-open it only if the log's retention is ever extended far enough for "until eviction" to stop
  being an answer.
