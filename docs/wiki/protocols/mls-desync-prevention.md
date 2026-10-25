# MLS desync prevention

Tactics used to keep **server routing / epoch tracking**, **OpenMLS group state**, and **delivery order** aligned. Pair with [`mls-recovery-ladder.md`](mls-recovery-ladder.md) for what happens _after_ a fault is detected.

Run the MLS service and call-site suites in `frontend` after changing **`runCommitTransaction`** or the staged commit primitives (`stageAddMembers` / `mergePendingCommit` / `clearPendingCommit` / `exportRatchetTree`).

## Ordered tactics (by layer)

### 1. Server - epoch-gated commits

- **`POST /api/mls/commit`** — `baseEpoch` must match the group row **`activeEpoch`** (except fast-forward when `activeEpoch === 0`). A **Redis lock** (`mls:commitlock:{groupId}`) serializes concurrent validators so two devices cannot both advance from the same epoch. On success, the commit bytes are stored in the commit-log and **`activeEpoch ← baseEpoch + 1`** atomically, then fanned out. Rejects: **`epoch_mismatch`**, **`concurrent_commit`**, and **a commit carrying no `proto`** — a
  commit nothing can replay may not advance the epoch. Source: `app.controller.ts` → `validateCommit`.

  **"ATOMICALLY" WAS THIS PAGE'S CLAIM BEFORE IT WAS THE CODE'S, AND THAT COST A CONVERSATION AN
  EPOCH.** Until 2026-09-02 the insert sat OUTSIDE the transaction that advanced `activeEpoch`,
  wrapped in `try`/`catch` → `logger.warn` and reasoned as best-effort. `IDX_mls_commit_log_group_epoch`
  is UNIQUE on `(groupId, baseEpoch)`, so a row skipped there can never be written by anybody: epoch
  121 of DM `7da231f8` is absent from a log running 0..129, permanently, and every device stopped at
  121 needs a full rung-2 re-Welcome for the life of the group. The insert now shares the
  transaction, and a failure fails the commit — one round-trip for the committer instead of a hole
  for everyone.

- **A SEND FROM A DEVICE THAT HOLDS NO LEAF IS REFUSED, NOT FANNED OUT.** `status = 'active'` gated
  recipient resolution and nothing gated the SENDER, so a `pending` device's six messages became
  thirty rows of ciphertext nobody in the group could open (prod, 2026-09-02, 24 seconds).
  `sendMessage` now reads the sender's own `dm_device_group_memberships` row before resolving any
  recipient and answers **`403 sender_not_active`** with the status. Handshake frames (Welcome,
  Commit) are exempt: they are the path OUT of `pending`, and refusing them would make the gate a
  deadlock. A missing row is logged and allowed — that is an external join in flight.

### 2. Server - coordinated reset and bootstrap: DELETED, AND NOTHING REPLACED IT

> The tactics below are the prose; the machine they act on is drawn on
> [`mls-graine-state-machine.md`](mls-graine-state-machine.md).

This section described `POST /api/mls/groups/:groupId/reset`, `POST .../claim-bootstrap` and
`GET .../bootstrap-info`, backed by an optimistic lock on `bootstrapVersion`. **None of the three
routes exists and neither does that column**, verified 2026-09-12: the successor/reboot machinery
they belonged to went with `009_drop_group_successor.sql`.

What took their place is the external commit. A device holding no local state re-enters by building
one against the published `GroupInfo` - no reset, no bootstrap lock, no peer liveness required - and
the server's strict gate (`baseEpoch == activeEpoch`, tactic 1 below) is what keeps that safe. See
[`mls-recovery-ladder.md`](mls-recovery-ladder.md). The one case it cannot serve, a published base
behind `activeEpoch` with no holder online, is a dead end rather than something a reset would fix:
only a member holding the tree can mint a base, so there is nothing for a reset to reset.

### 3. Server - add-member races

- **The base is a PAIR, and one client function reads it** (`BaseMlsService.publishCurrentBase`).
  A GroupInfo blob and the epoch it belongs to are read under the MLS lock and published
  together; the round trip happens outside the lock, because a base published one epoch BEHIND
  the group is refused harmlessly by the monotonic rule while a base labelled AHEAD of what it
  contains owns that epoch for ever. Three paths publish one - the refresh after a staged
  commit, a distribution group's create path, and the external join that carries its own
  successor inside the submission - and all three go through that function.
- **`POST/DELETE /api/mls/add-lock`** — Redis lock **`mls:addlock:{groupId}`** so only one inviter runs **add member + Welcome** at a time for that group. Used from **`processPendingInvitations`** and discovery re-bootstrap.
  **THE LOCK HAS TWO DOORS AND ONE IMPLEMENTATION** (`utils/add-lock.ts`): this JWT route, and
  `mls/push/acquire-add-lock` for the Android background service, which cannot mint a JWT. The
  key, the `userId:deviceId` owner, the `ADD_LOCK_TTL_SEC` lifetime and the ownership-checked
  release are decided there and nowhere else. **The lifetime is not the caller's to choose** -
  it used to be a `ttlMs` on the JWT body that no caller ever varied, while the push door
  hard-coded half of it, which put the SHORTER lock on the SLOWER path.

### 4. Client - one staged commit regime (ADD + REMOVE)

- **`runCommitTransaction(groupId, stageFn, opts)`** in **`BaseMlsService`** — the single primitive behind **every** structural commit. Under the MLS lock: stage the commit WITHOUT merging (`stageAddMembers` / `stageRemoveMembers*`), read the current **pre-merge** epoch (`freshEpoch`), **`validateCommitEpoch(groupId, baseEpoch)`**, then on accept **`mergePendingCommit`** + broadcast (and **`exportRatchetTree`** for an ADD Welcome), on reject **`clearPendingCommit`** and throw. Because the merge happens only after the server accepts, a rejected commit never advances the local epoch — the whole class of "sender fork" desyncs disappears. `baseEpoch` is the raw current epoch (no `-1` formula: nothing is merged before validation). The platform primitives (`stage*` / `merge` / `clear` / `exportRatchetTree` / `freshEpoch`) are the only pieces that differ between WASM (`WebMlsService`) and native (`TauriMlsService`).

- **Tauri** — **`_epochByGroupId`** + **`refreshEpochCache`** keep **`getEpoch()`** meaningful for validation and UI; `freshEpoch` reads the authoritative pre-merge epoch via `obtenir_epoch`; **`forgetGroup`** clears the cache.

### 5. Client - message ordering and gaps

- **Queue priority (Tauri)** — **`group_reset`** control → **Welcome queue** → **application queue** so resets and welcomes are applied before ciphertext that assumes a joined epoch.

- **Rust / WASM epoch gap** — **`frontend/mls-core`** (and Tauri path) detect **message epoch > group epoch** and fail fast so the caller can run **gap recovery** instead of consuming ratchet material incorrectly.

- **Commit-log replay (rung 1)** — on that gap, the pipeline (`setupMessageHandler` → `attemptCommitReplay`) fetches the missed ordered commits from the server commit-log (**`GET /api/mls/commits/:groupId?sinceEpoch=N`**, written atomically with the epoch advance in **`POST /api/mls/commit`**) and re-applies them to catch the epoch up **without dropping state**. Only a below-floor (pruned) commit, a NAMED HOLE, or an unapplicable one falls through to the destructive rung-2 forget + re-Welcome. See [`mls-recovery-ladder.md`](mls-recovery-ladder.md) step 4.

- **A HOLE IN THE MIDDLE OF THE LOG IS AN ANSWER THE SERVER GIVES, not one the client discovers by
  failing.** `belowFloor` only ever described the START of the requested range, so a device at 120
  handed `[120, 122, 123, …]` applied 120, threw on 122, froze its outbox and waited out
  `EPOCH_GAP_ESCALATION_MS` — 30 seconds during which every arriving frame was ACKed and dropped.
  `getCommitsSince` now walks for contiguity, truncates at the first missing epoch and returns it as
  **`gapAt`** (also when the log simply stops short of `activeEpoch`); `attemptCommitReplay` treats it
  as terminating and applies nothing, and `setupMessageHandler` escalates to rung 2 on that proof.
  PRUNING and a HOLE stay separate: both end rung 1, only the second accuses the commit path, so
  `belowFloor` suppresses the `gapAt` report rather than doubling it.

- **`connection.ts`** — Rung-2 fallback: stale decrypt / epoch error patterns can trigger **`forgetGroup`** + **`sendReinviteRequest`** when local epoch is behind the message and rung-1 replay could not catch up (see `[RECOVER]` / `[GAP]` logs).

### 6. Client - there is ONE way to create a group, and it recovers orphans itself

- **`create_group` is the only entry point** (WASM `create_group`, Tauri `creer_groupe`). When an
  orphan for that `group_id` already sits in OpenMLS storage - the shape left by a `forget_group`
  without a full reload - it LOADS that orphan back into `self.groups` and *then* returns
  `Err("GroupAlreadyExists")`. The error is therefore good news: the caller has a usable group. Its
  one handler is `setupMessageHandler.ts` (`GroupAlreadyExists` -> forget storage + re-join).

- **`force_create_group` and `drop_group` are GONE (2026-09-12), and nothing called either.** They
  were a complete vertical stack each - TS interface, abstract, two platform implementations, a
  Tauri command (`supprimer_groupe`), a WASM export, an `MlsManager` method - with zero production
  call sites and zero tests. `force_create_group` wiped local state before creating; the paragraph
  that used to sit here described it as the second half of a `sendGroupReset` -> `forceCreateGroup`
  re-bootstrap, and that whole protocol went with `d54a58ae2 feat: remove broken MLS
  bootstrap/recovery system`. Neither `sendGroupReset` nor the `forcer_creation_groupe` command the
  text named has existed since. The two implementations had also silently diverged: the Web one
  really wiped orphan state, while the Tauri one just called `creer_groupe` and swallowed the error,
  so the same method name meant two different things per platform.

  `drop_group` was the "Poison Pill": it purged the group and set its epoch lock to `u64::MAX`, so
  no Welcome could EVER be accepted for that id again. Unreachable and irreversible - the one shape
  that can only subtract availability - and bug C3 in
  [mls-protocol](mls-protocol.md) records its last real use being removed as a fix.

### 6bis. Client - there is ONE way to stop holding a group, and it is durable

`dropGroupState` ([`utils/chat/dropGroupState.ts`](../../../frontend/src/lib/utils/chat/dropGroupState.ts))
is the only thing that makes `holdsGroupState` answer false. It is the mirror of section 6: one
entry point in, one out.

`forgetGroup` itself was called at SEVENTEEN sites and two things that belong to the drop were
written by hand beside it, so both drifted:

| What the drop owes | Sites that did it, before |
| --- | --- |
| An encrypted checkpoint - `forget_group` mutates the OpenMLS store and the snapshot is written separately (section 7) | 10 of 17 |
| Clearing the epoch gap - `isInEpochGap` is a claim about HELD state lagging, and a device holding nothing has no epoch to be behind | 2 of 17 |

The checkpoint is the half that cost something. `recoverForkedGroup` forgot a forked tree, asked to
be re-added and wrote nothing: a page killed between the two came back holding the fork it had just
abandoned, and the re-Welcome it had asked for was then ignored as idempotent, because the group was
local again. The gap entry is the quieter half: left behind, it refuses to encrypt in the group the
device has just re-joined cleanly (`canSendInGroup`), and keeps `anyEpochGapArmed` true, which is
what holds the sync watchdog on its fine tick for the rest of the session.

**`checkpoint` states a fact, not a preference.** `'awaited'` - the state is in the snapshot and the
caller waits for the snapshot without it. `'deferred'` - the same, from a holder of the MLS client
mutex, where awaiting a whole encrypted save (1.7 s on a phone) would put it in front of every other
MLS operation; the write is the same call, started and left to the session persister.
`'never-persisted'` - the state was built in memory during this very call and no checkpoint has run
since, which is `externalJoin` discarding a refused commit: there is nothing durable to undo, and a
save would cost one per failed attempt.

`dropGroupState.onePolicy.test.ts` drives five PATHS over one table - the exported entry points a
caller really uses - because a path that keeps its own `forgetGroup` never reaches the shared
function, and no test of the shared function can see it.

### 6ter. Client - an eviction is learnt five ways and recorded once

The sibling of 6bis, one rung out: that one is the single way this device stops HOLDING a group,
this one is the single way it records that it is no longer IN one.
`recordEviction` ([`utils/chat/eviction.ts`](../../../frontend/src/lib/utils/chat/eviction.ts)) is
that record.

A client can find out six ways, at five sites - a Remove commit it applies, the exclusion its author
announces, an inbound frame refused as `evicted`, a membership check before a send or on selecting
the conversation, a send the server refuses, and `NotAGroupMemberError`. What is OWED once the fact
is known is the same every time, and every site wrote it out by hand:

| Site | Retired the row | Told the user |
| --- | --- | --- |
| the commit applied, and the frame refused as evicted | yes | no |
| the exclusion announced by its author | yes | yes |
| the outbox, before its send and after the refusal | yes, on a hook shared with a group DELETION | no |
| the membership check on selection, and the server's own refusal | **no** | yes |

The last row is the one the user meets. `verifyCurrentUserMembership` runs on every conversation
selection, learnt the eviction from the authoritative local state, and wrote it NOWHERE: a notice in
the thread, `sendError` on the composer and a thirty-second entry in `membershipCache`, all of which
die with the page. The row stayed `active`, so the next load asked the members-only endpoint for its
roster again (the 403 of GRP-3 and GRP-6, from a third door), the re-add guards did not know to stand
down, and the fact had to be re-learnt on the next selection, for ever.

**The evidence is the only thing a site decides, and two of the six are MISSES.** `outbound-refusal`
and `server-refusal` mean the Remove commit never reached this device, so a message was written,
encrypted and refused to learn what a frame already stated. The line those two produce is worded so
it cannot wear the healthy shape - it never says `Removed from ...` - which is what stops any rule
written for the healthy path from forgiving them, in the campaign watcher or anywhere else.

**Dropping the local MLS state is NOT part of this**, and the separation is deliberate: that is
`dropGroupState` (6bis), an evicted group's tree is what still opens the frames of the epochs this
device WAS a member for, and forgetting it is what makes a later frame stop classifying as `evicted`
at all. The row is what refuses the send, the roster, the re-add and the welcome_request. Two axes,
one implementation each; `memberRemoved` is simply a site that legitimately does both.

`recordEviction.onePolicy.test.ts` drives the six evidences over one table, through the five real
entry points, for the same reason 6bis does.

**And nothing retracted the notice, on the one evidence that always writes it.** The notice is the
one statement in a thread the user cannot dismiss, so when a re-admission disproves it
`retractEvictionNotice` withdraws it - `deleteMessage` rather than a tombstone, because this is a
message NO OTHER DEVICE EVER HAD. Until 2026-09-22 that withdrawal hung off the
`readmittedAfterEviction` branch of the Welcome guard, which is `holdsGroupState && !isGroupActive`
- and `system-event`, the announcement, is the one evidence that makes the FIRST half false: it
calls `dropGroupState` and only then records the eviction. So a removal its author undid a moment
later (a moderation slip, a kick-and-re-add) left a permanent "Vous avez ete retire de ce groupe"
sitting above a conversation that worked perfectly - reported from a real client that day, with
messages sending and arriving underneath it.

The withdrawal now hangs off the INSTALL, once, keyed on the group that actually came back. Before
`processWelcome` was the other half of the same mistake: a Welcome that fails to install
(`NoMatchingKeyPackage`, recovery deferred past the lock) leaves this device evicted, and
withdrawing on the frame alone retracted a TRUE sentence and left the eviction silent. **The proof
is the installed group, not the frame that carried it, and not either of the two ways of reaching
it.** Both directions are gated in `setupMessageHandler.test.ts`.

### 7. Client - persistence write-if-newer (Web/IndexedDB)

- **Monotonic snapshot version** (**`utils/hex.ts`**) — the encrypted MLS checkpoint is written under a **write-if-newer** guard. Every serialized snapshot is tagged (`tagMlsSnapshot`) with an increasing version at the synchronous capture moment; the version rides with the bytes via a `WeakMap` (`propagateMlsSnapshotVersion` across the plain→encrypted step) so the off-thread Argon2 encryption cannot reorder it. **`saveMlsStateEncrypted`** does an IDB read-modify-write and refuses any blob whose version is not strictly newer than the stored **`MLS_STATE_VERSION_KEY`**. This stops a slow encrypted flush (`mlsStatePersister`, worker Argon2) from overwriting a fresher concurrent write (`generateKeyPackage`, main-thread Argon2) — which would silently regress the persisted epoch on the next reload. The in-memory counter is reseeded from the stored version at load (`seedMlsSnapshotSeq`) so a fresh session never emits a version below what is already on disk. Only a plain integer is stored — no groupId/epoch at rest, so privacy is unchanged. Web-only: Tauri persists to the filesystem under its own `mls_bin_write_lock`.

### 8. Client - no state replacement may rewind this device's own send ratchet

**A REPLACEMENT GUARD MUST MEASURE THE THING AT RISK.** Every path that replaces the live MLS client
has the same shape - snapshot, work on the copy, install the result - and every one of them is a
window in which the live client can advance. `sendMessage` is exactly that: it moves this device's
send ratchet. Install a state taken before it and the ratchet goes BACK; the next frame re-issues a
spent generation, and the peer refuses it with `SecretReuseError`, reporting - correctly - that the
sender's ratchet rewound. The frame is not lost, but the receiver files it as a loss and pays a full
history reconciliation to discover that both sides already agree.

Every such seam therefore passes **two** guards, and neither substitutes for the other:

- **Epoch-monotonic** (`swapClientMonotonic` on web, `MlsManager::reload_is_monotonic` in mls-core):
  refuses a candidate that would move a live group to a LOWER epoch. This answers "is this snapshot
  from an older epoch" **and nothing else**.
- **Not-overtaken** (`installUnlessOvertaken` on web; on native `MlsManager::has_unsaved_ratchet_advance`,
  read inside `reload_into` under the manager lock): refuses a candidate derived before a send,
  burn or DECRYPTED FRAME this device has already made. A generation that moved INSIDE one epoch is
  invisible to the epoch guard, which is why the epoch half alone let this defect run.

**Native: the flag lives in the manager and covers receives (2026-10-06, RESUME-B-1).** The guard
that stood in `TauriMlsService` counted SENDS in the WebView, so a received frame the checkpoint did
not yet hold was invisible to it - and a frame landing between its check and the swap was
overwritten. Measured on the Mi 9T 2026-09-08 09:53: generations 45 and 46, already read, were
derived again 112 ms after `mls.bin reloaded on resume` and accepted; the reload was the only event
between the two pairs and no epoch moved. `recharger_mls_au_resume` now answers a typed
`ReloadOutcome` (`reloaded` / `nothing-on-disk` / `epoch-regression` / `live-ahead`); on
`live-ahead` the WebView persists the live state, which is what makes the next resume safe. The flag
is set by `send_message`, `skip_send_generations` and a decrypted application frame, cleared by
serialisation, and is NOT set by a load (a fresh manager is "dirty" for the snapshot cache but holds
exactly the file). Pinned by `mls-core/tests/unsaved_ratchet_advance.rs` (including the rewind
itself, reproduced without a phone) and `storage.rs::a_reload_is_refused_while_the_live_manager_holds_an_unsaved_receive`.
It clears at serialisation, not at the write: a failed write is reported by the command and leaves the
file behind with the flag down. A manager that is ahead on a background engine's advance too is
resolved in favour of the live one (the persist overwrites it) - the merge nobody has written.

The counter is `BaseMlsService.liveMutations`, read at the snapshot and again at the install: a COUNT
rather than a flag, because the question compares two instants rather than asking "recently?".

The send seam feeds it. `sendMessage` is concrete in `BaseMlsService` and carries all three
outbound invariants - wait for catch-up idle, count the mutation, checkpoint it - so a platform
supplies only `encryptForSend`. It became a template method the day the checkpoint was found at TWO
of the EIGHTEEN call sites that reach a send: the other sixteen (read receipts, reactions, edits,
deletes, pins, group control, calls) advanced the ratchet and persisted nothing, leaving `mls.bin`
structurally behind the live client. A rule each caller has to remember is a rule the next caller
will not.

**DURABILITY MUST NOT GATE DELIVERY, AND THE GUARD DOES NOT SURVIVE A PAGE LOAD.** Two things were
measured on 2026-08-14 that this section did not account for, both now fixed.

The first: `endBulkIngest` awaits every observer, and the persister's `onBulkIngestEnd` awaited the whole
encrypted checkpoint - so a frame that arrived during the flush was not decrypted until the disk
answered. Measured at **8.0 s on a cold web client** and **3.2 s on the phone**, with an ordinary
50 ms API round trip inside the gap proving nothing else was blocked, against 279-327 ms on the four
passes that did not hit it. The flush is now started and not awaited. Nothing is risked: ordering is
already held by the monotonic snapshot version (section 7), and this checkpoint carries INBOUND state,
which a reload recovers by replaying from the server. `saveState`'s own cost is now logged separately
from the sealing, because they are different questions and neither had ever been printed.

The second: `liveMutations` and every watermark compared against it are **per-page-session** state,
while the OUTBOX is durable. A client that sends, is reloaded before the checkpoint lands, and then
drains its queue encrypts those entries against an `mls.bin` that is behind its own previous sends -
and the peers refuse them with `SecretReuseError`. Reproduced twice on a settled fleet.

The invariant is *`mls.bin` is never behind a frame that has already left the device*, and it was
first read as "only an awaited checkpoint on the send path can hold it". **That reading was wrong,
and the measurement below is what refuted it**: awaiting costs 1.7 s per message on a phone, which is
not a trade worth making. The invariant does not in fact require the state to be durable at send
time - only that a state restored behind it be RECOGNISED and repaired, which is a counter and a burn
rather than a disk write. The outbound checkpoint in `BaseMlsService.emitFrame` therefore does not
await, on either platform.

**AND THE SEAM THAT WAS KEPT FOR THE AWAIT IS GONE (2026-09-13).** `checkpointAfterSend` was left as
a `protected` hook so native could override it and await; its docblock said native already did. No
override was ever written, `git log -S` over `TauriMlsService.ts` returns nothing, and by the
reading above none is owed - so the hook was deleted and the call inlined. What the seam was
guarding is now asserted where it actually lives: `BaseMlsService.sendSeam.test.ts` pins that the
ledger write happens BEFORE the POST, which nothing pinned until then.

**THE MEASUREMENT REFUTES THE OBVIOUS FIX, AND FOUND A DIFFERENT DEFECT INSTEAD.** The split log
priced a native checkpoint at **3.7 s, of which `saveState` alone is 1.7 s** (1683 / 1690 / 1761 ms
on three consecutive sends, A1, 2026-08-14). So awaiting on native costs 1.7 s **per send**, which
is not a trade worth making, and the earlier "~80 ms" estimate this decision was first taken on was
wrong by a factor of twenty. The remaining 2.0 s was the real find: the persister called `saveState`
and then `saveMlsStateEncrypted`, which is one durable write on web and **two on native** - native's
`sauvegarder_mls_et_persister` has already written `mls.bin` when it returns, so the second call
wrote the same file with the same bytes, marshalled through IPC as a `number[]`, the exact cost the
single-invoke design existed to avoid. The codebase already knew this, on `persistFreshState`; the
checkpoint path carried its own copy of the answer and the copy was wrong. Fixed by making
`IMlsService.persistCheckpoint` the one seam every checkpoint goes through - `rotateDeviceIdentity`,
the persister, the structural checkpoint - so no caller has to know which platform it is on.

**THE FIX IS NOW MEASURED ON HARDWARE, AND THE DUPLICATE IS GONE** (A1, new APK, 2026-08-15). A
green build proves nothing about a write, so the number was read off the phone actually running:
**1 454 / 1 510 / 1 512 / 1 560 / 1 597 ms, median 1 512 ms** over one MSG pass - against 3.7 s
before, and slightly under the 1.7 s the split log predicted would remain. Web on the same run, for
scale: median 58 ms over 37 checkpoints.

Nothing needed instrumenting - the persister already logs `[MLS] Encrypted state checkpoint
persisted. (N ms)`. What needed care was ATTRIBUTION, because one capture holds several consoles and
a native checkpoint costs twenty-five times a web one: averaged together they produce a number
belonging to no device. `ckpt.mjs` calls a stream native only when its OWN lines say `mode=tauri`,
and the check is self-proving here - the only streams that matched were the two named `a1`.

What is still owed for the outbox hole is therefore NOT an awaited checkpoint. The shape that fits
the cost is a durable record of what the ratchet has already spent, written per send at the price of
a key/value write rather than a snapshot, and consulted at load.

> **THAT RECORD WAS BUILT - IT IS THE SUBSECTION DIRECTLY BELOW, SHIPPED 2026-08-14.** This paragraph
> states the DEBT and the next one records its PAYMENT, and reading the first without the second is
> not a hypothetical failure: a P1 was filed on 2026-09-06 concluding *"that record has not been
> written"*, which would have had someone rebuild `sendRatchetLedger.ts` from scratch. **What the
> ledger covers is the JS load path**; the native outbox drain is a separate engine that does not
> consult it, and that gap - not a missing ledger - is what remains open in
> [backlog](../backlog.md).

#### The burn - designed against the OpenMLS source and shipped 2026-08-14

**THE REPAIR IS A BURN, AND THIS CLIENT'S OWN RATCHET CONFIGURATION IS WHAT MAKES IT SAFE.** Read in
`openmls-0.8.1/src/tree/sender_ratchet.rs`, against the configuration `mls-core/src/group.rs`
already sets for every group it creates or joins - `SenderRatchetConfiguration::new(2000, 2000)`:

- **an encryption ratchet has no public way to move without producing a frame.**
  `RatchetSecret::set_generation` is `#[cfg(test)]` and `ratchet_forward` is `pub(crate)`, so
  advancing the send ratchet by N means encrypting N times and discarding the ciphertext. That is
  the entire implementation, and there is no other one to look for.
- **a receiver ratchets FORWARD on demand and keeps what it skips.** `secret_for_decryption` derives
  every generation between its head and the one asked for, pushes each into `past_secrets` as
  `Some`, and refuses only past `maximum_forward_distance`. So burning more than was really spent
  costs a handful of unused 48-byte keys and nothing else - and a frame still in flight during the
  burn decrypts afterwards out of that same window (`out_of_order_tolerance`, also 2000).
- **reuse is the one thing it will not forgive.** A generation already consumed is `None` in
  `past_secrets`, and `.take()` on it returns exactly `SecretReuseError` - the error the peers
  reported, from the one branch that can produce it.

**The failure mode is therefore asymmetric, and every rounding decision leans on that**: burning too
FEW reproduces the defect, burning too MANY is free. This is what lets the deficit be estimated
rather than measured, and it is why the design below needs no new atomicity anywhere.

**THE DEFICIT IS COUNTED OUTSIDE `mls.bin`, BECAUSE `mls.bin` IS THE THING THAT IS WRONG.** Per
group, two numbers:

- **emitted** - frames this device has encrypted, bumped in `sendMessage` the instant
  `encryptForSend` returns and BEFORE the POST. In `localStorage`, because it is the only store that
  is both synchronous and survives the teardown that opens this window; an async store has the same
  race as the checkpoint it exists to compensate for.
- **persisted** - what `emitted` was when the last successful checkpoint was TAKEN: read before
  `saveState` is called, written after it resolves. In that order and no other. A send landing during
  the save is then counted as unpersisted and over-burns by one; the reverse order under-burns, which
  is the defect itself.

At load, `deficit = emitted - persisted`; for each group with a positive one, encrypt-and-discard
that many times, reset the pair, checkpoint.

**What it deliberately does NOT do is change the serialised state format.** Carrying the counter
inside the snapshot would pair it with the ratchet atomically and remove the ordering discipline
above - and it would make a migration of the one file whose corruption is unrecoverable. The
asymmetry buys the same safety for nothing.

**One seam, in Rust**: `skip_generations(group_id, n)` in `mls-core`, so a burn costs native one IPC
rather than one per generation and both platforms burn through identical code.

**What is already right and must not be broken.** The Android background sender ALREADY holds the
invariant this closes: `send_messages_background_with_key` encrypts the whole batch, persists once,
and returns no ciphertext until that write succeeded - *a frame handed to the caller is a frame the
caller will POST*. It is the FOREGROUND that violates it, and only for the 1.7 s reason above. A
background send therefore never contributes to the deficit: it leaves the saved state AHEAD of the
JS counters, which yields zero or an over-burn. Safe in both directions.

**Where each piece lives.** `MlsManager::skip_send_generations` (mls-core) is the burn;
`WasmMlsClient::skip_send_generations` and the `skip_send_generations` Tauri command are the two
crossings, and the command sits in the single un-gated `generate_handler!`, so **iOS and Android get
it from the same code** - the only platform split in this area is the background sender's entry
point, never its logic. `src/lib/mls-client/sendRatchetLedger.ts` holds the counters (**`mls-client/`, not
`services/`** - this page said `services/` until 2026-09-06, and a grep at the wrong path returning
nothing is half of why the P1 above concluded the mechanism did not exist),
`BaseMlsService.persistCheckpoint` the pairing, and `BaseMlsService.reconcileSendRatchets` the
repair, run from inside the `init` promise every caller already awaits so nothing can send before it.

**WHAT THE LEDGER DOES NOT COVER, AND IT IS NOT A DETAIL.** The counters are read and written by the
FOREGROUND only. Android runs four engines against one ratchet - foreground Tauri, FCM JNI, Worker
JNI and the native outbox drain `send_messages_background_with_key` - and the drain loads `mls.bin`,
encrypts every queued entry and saves, without ever asking what the foreground has emitted but not
yet checkpointed. Two things hold it back and both are visibility-shaped rather than fact-shaped:
`background_write_mls_bin_if_unchanged` refuses while `foreground_is_active()`, which is a 30-second deadline
released deliberately on `hidden` (and, since 2026-10-23, over a file that changed since the drain loaded it); and `reloadStateFromDisk`, the one thing that re-syncs the
foreground to a background advance, has exactly one caller - the RESUME branch of
`visibilitychange`. An app that is backgrounded and stays alive has released the guard, still holds
a live in-memory client, and will not reload until a resume that may never come.

**HOW IT IS PROVEN, AND WHY THE PROOF IS IN RUST.** `mls-core/tests/burn_spent_generations.rs` runs
two real clients: alice sends two frames, bob consumes both generations, alice is restored from a
snapshot taken before them. The first test asserts the FAULT - bob refuses the next frame with
`SecretReuse` - so the day the defect is fixed somewhere else, that test fails and says the repair
has become dead weight. The second asserts the repair, and the third asserts that burning five where
two were spent still decrypts, which is the property the ledger's deliberate over-count depends on.
Four tests, no device, no timing.

What that CANNOT establish is the seam above it - that the count survives the teardown and the load
path consults it. `burn.mjs` in the harness does, against production: send, reload inside the window,
send again.

**WEB: TAKEN, 2026-08-14.** Deficit 1 before the reload, 0 after it, next frame delivered in 415 ms,
zero loss lines on the peer. Two findings came with it. The window has narrowed to **under 60 ms** -
at the 300 ms the original defect was measured at, the checkpoint had already landed and the run was
reported `INCONCLUSIVE`, which is what a check must do when it fails to reproduce its own premise.
And the console capture MISSED the repair's log line on the passing run, because a reload that does
not raise the PIN gate initialises before a session can re-attach: the verdict rests on the durable
counters instead, read on either side of the reload. Both lessons are in
[testing-methodology](../testing-methodology.md) under rule 4.

**NATIVE: TAKEN, 2026-08-14.** The window there is 1.7 s rather than 60 ms, so it is far easier to
enter: a 300 ms reload found **2** unpersisted frames, the repair reported burning 2, the next frame
decrypted in 3 772 ms and the peer reported no loss. Two things that run taught, both now in the
check: the residual deficit AFTER the load is not a post-condition - it is a live quantity, bumped by
the read receipts the restored session sends on opening the conversation and cleared 1.7 s later by
the phone's own checkpoint - and `burnedLine` legitimately exceeded the pre-reload snapshot, because a
send landed between the two. The repair burns what the ledger holds AT LOAD, which is the only figure
that can be right; a check comparing the two for equality would have called a correct run a fault.

**RE-TAKEN ON THE DEPLOYED BUNDLE, 2026-08-15, AND THE RECIPE STOPPED BEING A RACE.** W1 burnt 1
with the next frame decrypted in 447 ms; A1 burnt 1, next frame 3 589 ms; both peers clean, no loss
line on either side. Getting there needed one change to the check. **A fixed delay cannot enter a
window narrower than itself**, and the window on web is now ~58 ms, so `--delay 300` reloaded at
136 ms with the ledger already at 0 and reported `INCONCLUSIVE` - correct, but it would have done so
for ever, and an INCONCLUSIVE that never resolves is indistinguishable from a repair with nothing to
do. The reload is now GATED on the premise instead: send without awaiting the composer's own 100 ms
post-condition, poll `emitted - persisted`, and reload the instant it is positive. The window opened
on the FIRST send on both platforms. This is rule 7 - a precondition the client agrees with beats
one the check hopes for.

**THE COUNT IS KEPT PER EPOCH, AND BURNT IN THE EPOCH IT WAS COUNTED IN (2026-10-23).** A generation
belongs to one epoch's ratchet, and a merge starts the next epoch at generation 0. The ledger counted
per group, so a reload whose state sat BEHIND an epoch this device had already sent in burnt those
frames in the restored epoch - a ratchet nobody reads any more - and when the group reached the later
epoch again it re-issued every generation the peers had consumed there. Two ways to be behind: the
commit's own stage checkpoint (awaited before its first request, section 4 and
[mls-protocol](mls-protocol.md)) is the last one when a crash follows the merge and the sends of the
next epoch, and the settle merges the same commit again; or a received commit was processed and never
checkpointed, and the replay re-applies it. Found by review of #2269, whose stage checkpoint made the
first way deterministic.

- Each frame is counted against the epoch it was SEALED at, read from the frame itself
  (`sealedFrameEpoch.ts`, the RFC 9420 header) rather than from a second read of the state an incoming
  commit can move.
- At load, `sendRatchetDebt` places each entry against the restored epoch: AT it, `emitted - persisted`
  is burnt at once; AHEAD of it, all of `emitted` is owed THERE (the snapshot holds nothing of that
  epoch) and burnt by `burnOwedOnArrival` before the first frame sealed at it; BEHIND it, the entry is
  dead and forgotten, as are a group's entries when the state no longer holds the group.
- An owed burn lives in memory only, so it stays OUT OF what a checkpoint declares durable until it
  has run: `persistCheckpoint` drops every owed `group@epoch` from the counts it snapshots
  (`sendRatchetsNotDurable`). Otherwise a checkpoint landing between the settle's merge and the first
  send wrote the epoch without the burn and committed `persisted = emitted` for it, and the next load
  found nothing owed and re-issued generation 0 (the final check of #2269, 2026-10-23). The entry is
  removed only once its burn has run.
- One owed burn at a time per group, and every send awaits it (`settleOwedBurns`): two sends used to
  race, the second sealing while the first's burn was still in the platform. A burn that fails refuses
  the send (`OwedSendBurnFailedError`) and stays owed for the next one.
- When the held groups cannot be listed (`heldGroupsKnown` false) or an epoch cannot be read, there is
  no epoch to judge by: the debt is burnt in whatever epoch the state holds, said at `warn` with the
  number of groups, and those keys are never declared durable this session, so the next load judges
  them again. Over-burning is free; skipping the repair was not.
- An incoming commit is not held off by the send barrier, so the group can reach an owing epoch
  between the burn and the encrypt. `sealPastOwedBurns` reads the sealed frame's epoch and never posts
  a frame sealed at an epoch that still owes a burn: it says so at `error`, burns, and seals again.
- Entries written before this change carry no epoch, and are read the way their writer counted:
  against the restored epoch ([legacy-compatibility](../legacy-compatibility.md)).

Proven in `mls-core/tests/burn_spent_generations.rs` on two real clients (the burn before the merge
leaves `SecretReuse`, the burn after it decrypts; and the frame header layout the web reader relies
on, against openmls's own `parse_message_epoch`), and in `BaseMlsService.sendRatchet.test.ts` on a
ratchet model through the real reconcile and send path - the review's sequence, stage, send, merge,
send in E+1, crash, reload, which re-used generation `5:0` on the per-group ledger.

The background handoff is ordered for the same reason: on `hidden` the checkpoint is flushed
**before** `pause_mls_foreground` releases the native guard. Releasing it is what lets a background
JNI engine load `mls.bin` and advance from it, so releasing it first hands that engine a state that
is already behind. The guard expires on its own after ~30 s, so nothing here rests on a clock - the
ordering is the guarantee.

### 9. Client - an application frame never straddles a local epoch advance

- **`runAsEpochSend` / `runAsEpochAdvance`** in
  [`epochSendBarrier.ts`](../../../frontend/src/lib/utils/chat/epochSendBarrier.ts) — a send is
  encrypt-then-POST with a suspension between them; a commit is stage-accept-merge. Nothing ordered
  the two, so a frame encrypted at epoch N could reach the wire after this device's own commit had
  moved every recipient to N+1. **Two past epochs of OpenMLS tolerance is what hid it**: one straddle
  is survived silently, and two commits in quick succession make the frame undecryptable for good
  while the sender considers it delivered. Measured on prod 2026-09-02 (DM `7da231f8`): seven frames
  across commits 128 and 129, the first 36 ms after the commit, four of them lost.

- The overlap is **deleted, not reconciled**. A frame is encrypted AND on the wire before a local
  commit starts, or it is encrypted after that commit merged; there is no third ordering and no clock
  in it. Re-encrypting a frame found stale would be a race that heals cleanly, which is still a
  defect.

- **The barrier is raised only under the MLS mutex, and that is the whole deadlock argument.**
  `runCommitTransaction` raises it inside `runUnderMlsLock`; the mutex being exclusive, a send that
  observes a raised barrier provably does not hold the mutex the advance is waiting for. Registered
  sends never need the mutex themselves (`encryptForSend` is a direct client call), so an advance
  holding it can wait for them to land. A barrier raised outside the mutex, or a send issued from
  inside it, reintroduces the cycle. A commit LENDS the mutex to the drain while its request is on the
  network; a borrower may see the barrier raised but never awaits a send, so the order holds
  ([mls-protocol](mls-protocol.md#a-commit-waiting-on-the-network-lends-the-mls-lock-to-other-groups-frames)).

## Verification

| Tactic | What must hold | How we check |
|---|---|---|
| `baseEpoch` formula | Web and Tauri stage the commit then read the pre-merge epoch in `runCommitTransaction` | `messaging.commit-log.spec.ts` |
| Commit log shares the advance's fate | A failing commit-log insert fails the commit; a protoless commit advances no epoch | `messaging.commit-log.spec.ts` |
| A hole is named, not discovered | `getCommitsSince` truncates at the gap and reports `gapAt`; `belowFloor` reports none | `messaging.commit-log.spec.ts`, `commitReplay.test.ts` |
| A leafless sender is refused | A `pending` device queues zero rows and gets `sender_not_active`; handshake frames still pass | `messaging.durability.spec.ts` |
| Send / advance never straddle | A frame is posted before a local commit starts, or encrypted after it merged - in both directions, and per group | `epochSendBarrier.test.ts` |
| Persistence monotonic | Stale encrypted flush cannot lower the stored blob | `hex.mlsVersion.test.ts` |
| Recovery vs prevention | Desync _handling_ (ACK rules, retries) | [`mls-recovery-ladder.md`](mls-recovery-ladder.md) |
| Server commit logic | Locks + `activeEpoch` rules | `messaging.commit-log.spec.ts`, `messaging.group-info.spec.ts` |

## Related sources

- [`apps/chat-delivery-service/src/services/messaging.service.ts`](../../../apps/chat-delivery-service/src/services/messaging.service.ts) — `validateCommit`, the ONE writer of `activeEpoch`, and `putGroupInfo`, the ONE writer of the base. `app.controller.ts` carries the scheduled jobs and the hourly reports only; the add-lock is in `locks.controller.ts`; `resetGroup`, `resetGroupEpoch` and `claim-bootstrap` do not exist.
- [`frontend/src/lib/services/BaseMlsService.ts`](../../../frontend/src/lib/services/BaseMlsService.ts) - `freshEpoch`, which is where a commit's `baseEpoch` is decided before it is published.
- [`frontend/mls-core/src/lib.rs`](../../../frontend/mls-core/src/lib.rs) — epoch gap detection in `process_incoming_message`.
- [`frontend/src/lib/utils/chat/actions.ts`](../../../frontend/src/lib/utils/chat/actions.ts) — `discoverMissingGroups`, and `handleWelcomeRequest`, the responder side of a re-add.

## See also

- [`mls-recovery-ladder.md`](mls-recovery-ladder.md) — Recovery steps after desync is detected
- [`mls-protocol.md`](mls-protocol.md) — MLS protocol overview, invariants, data model
- [`services/chat-delivery.md`](../services/chat-delivery.md) — Backend commit validation and epoch management

## The resume reload re-installed a receive ratchet behind the live one - the 2026-09-08 captures (Mi 9T)

Moved here from the backlog when the defect was fixed (#1527, [above](#8-client---no-state-replacement-may-rewind-this-devices-own-send-ratchet)). Two defects, one capture.

**The symptom**, read off W1 and W2 as `severe` during NOTIF-1b:

```
[MLS] LOST frame for 2bd5add9... from f7a9bb80...: generation consumed but this frame
      was never processed - the sender's ratchet rewound (SecretReuseError, frame 5p:1rurzth)
MLS decryption failed at exactly its own epoch, so no redelivery can help:
      group=2bd5add9... msg_epoch=139 group_epoch=139 err=SecretReuseError
```

`f7a9bb80...` is the PHONE, and the frame was its read receipt for the warm-up message. Same epoch on
both sides, so this is not an epoch gap: a generation the peers had already consumed was re-issued.
Both peers then paid a full history reconciliation to discover they already agreed.

**Four decryptions of the same two frames, one epoch, one sender leaf:**

| # | time | driver | generations | result |
| --- | --- | --- | --- | --- |
| 1 | 09:33:24.66 | FCM JNI push (`load_or_create`, then `decryptProto`) | 43 | OK, `writeFcmCache` |
| 2 | 09:33:30.564 | `recevoir_messages_batch group=2bd5add9... count=2` | 43, 44 | OK |
| 3 | 09:33:30.647 | `recevoir_messages_batch group=2bd5add9... count=2` **again, 83 ms later** | 43, 44 | **`SecretReuseError`** |
| 4 | 09:33:36.098 | `[PENDING] Fetched 2 pending` -> `[QUEUE] Drain` | 43, 44 | **OK AGAIN** |

Rows 2-3 are defect A (the archive-replay barrier read `isIdle` as "the group is quiet"; it now awaits `waitForCatchUpIdle()`, #435, `v0.16.6`). Row 4 is defect B: the same generations decrypting a third time can only mean the secret tree went backwards, and the only event between rows 3 and 4 is `[MLS][Tauri] mls.bin reloaded on resume (C2)`. The epoch never moved, so the epoch comparison could not see it.

**B isolated to the millisecond on a build without A (2026-09-08 09:53):**

```
09:53:03.355  gen 45
09:53:11.397  gen 45      09:53:11.438  gen 46
09:53:16.801  [MLS][Tauri] mls.bin reloaded on resume (C2) - group cache refreshed
09:53:16.913  gen 45      09:53:16.973  gen 46      <- both derived again, both succeed
```

**The key-package accusation fired in the same run** (09:51:43, `error` level, 13 ms before the reload installed): `[RESUME] reload DROPS KEY MATERIAL - live keystore holds 2625 key package(s), the mls.bin being loaded holds 2624`. Two ledgers, one mechanism: the reload puts back both the receive ratchet and the keystore, and that instrument counts only the second; it needs a mint between the last checkpoint and the resume, and a checkpoint cost 8.8-23 s on that device.

**What it did not cost the user:** the FCM cache pre-injected the message, the row landed, NOTIF-7 was `PASS`. The send-side rewind of 2026-09-06 (the phone's read receipt at epoch 139) is a different defect sharing only the error string.

## The checkpoint window, and the per-document snapshot counter (moved from the backlog, 2026-10-08)

**The checkpoint window.** The outbound checkpoint in `emitFrame` deliberately does not await, sized for 1.5 s in August, and costs 17-20 s on a 19.5 MB `mls.bin`, so any death of the process in that window restores a state behind frames that left. **Do NOT "fix" it by awaiting the checkpoint** (refuted in August at 1.7 s per send, seventeen now): the invariant is that a state restored behind a frame that left is RECOGNISED and repaired, which is a counter and a burn.

**The snapshot version is a per-document counter compared across documents (measured on TAB-4, 2026-09-05).** `saveMlsStateEncrypted` refuses any tagged write whose version is not strictly newer than the stored one. The version comes from `tagMlsSnapshot`, `++_snapshotSeq` - a module-level counter, so ONE COUNTER PER DOCUMENT, seeded from the persisted version by `seedMlsSnapshotSeq` on load. Within one tab that is right (a slow off-thread Argon2 flush finishing after a fresher one must not clobber it). Across two tabs both seed from stored version N and both produce N+1 with different bytes, so the guard sees `version <= stored` and drops the second: `Skipping stale MLS state write (v3294 <= stored v3294)` on an ordinary TAB-4 run. Whether anything is LOST is unanswered: a later flush from either tab carries a higher number and lands, so the state is expected to converge, untested and unmeasured. **A clock written by one writer is not evidence about another's ordering.** The wording is fixed (the collision case says so instead of claiming staleness, `hex.mlsVersion.test.ts` pins both branches); deciding it means a shared counter (a `BroadcastChannel` claim, or an IndexedDB read-modify-write in the same transaction as the put) or establishing that convergence always happens and how long it takes.

### The checkpoint a caller awaits is the one that exported after its change (2026-10-14)

`createMlsStatePersister` (`mls-client/mlsStatePersister.ts`) coalesces checkpoints: one runs, and
every request made while it runs shares ONE next checkpoint. Until 2026-10-14 a `flush()` made while
one was running returned **the running checkpoint's promise** and queued the next one unawaited. The
running checkpoint had exported the state before the caller's change, so the caller was told its
change was durable when it was not.

The caller that pays is `externalJoin`. It awaits `persistMlsStructuralCheckpoint` because the server
has already accepted the join, and a reload before it is on disk restores a device that is in the
tree, cannot read it, and joins again, which forks the group (prod, 2026-08-27). After a sign-in, a
checkpoint is running ~93 % of the time (Mi 9T, 2026-10-13: 247 checkpoints in 432 s,
[community-open-slowness](../frontend/community-open-slowness-mi9t-2026-10-13.md#finding-2---after-a-sign-in-the-checkpoint-runs-93--of-the-time-and-each-one-costs-more)),
so most joins of that storm were acknowledged early.

**Now**: `flush()` returns the running checkpoint only when nothing has been marked dirty since it
exported. Otherwise it returns the shared NEXT checkpoint, which starts once the running one ends.
The count is unchanged: N requests during one checkpoint still cost one more. **A failed write
re-raises the dirty flag**, so the next `flush` writes that state. It used to stay down, and nothing
would write that state until something else marked it. No new lock: the checkpoint takes neither the
MLS lock nor anything a flusher holds (`awaitRustMutations` waits only for `oublier_groupe` invokes).

Pinned by `mlsStatePersister.test.ts` ("a flush asked while a checkpoint is running", "a checkpoint
that FAILED leaves the state dirty"), both failing on the previous shape.

### A web checkpoint resolves only when its state is on disk (2026-10-21)

`WebMlsService.writeCheckpoint` used to resolve on every outcome of the version guard
(`saveMlsStateEncrypted`, `utils/hex.ts`). So when the guard dropped the write, every waiter of
`persistCheckpoint` still declared that state durable: the send ledger, the history marks,
`externalJoin`. When the stored blob is another tab's, those markers land in the `localStorage`
both tabs share.

**The guard now tells its own document from another one.** `hex.ts` records the version this
document last wrote, per account, once the transaction commits. An untagged write (a restore or a
migration) made BY THIS DOCUMENT clears the record. An older write then has two outcomes:

- **`superseded`**: the stored version is this document's own. Its counter is per document and
  monotonic, so that later capture holds everything the refused one did. This is the ordinary case
  when a direct `persistCheckpoint` (watchdog, burn, rotation, registry fallback) lands before a
  slower persister flight. It is silent, and a checkpoint resolves on it.
- **`stale`**: the stored version is another document's. This is a refusal.

`collision` (two documents reached the same version) stays a refusal, now at `warn` because it fails
a checkpoint. A device key change still requires `written`: a newer blob of this document may still
be sealed under the old key.

The own-document record was chosen over routing the direct callers through the persister. The
record is one fact, kept where the decision is made. Re-routing would touch four call sites, and the
fifth one written later would reopen the hole.

**What it does not see: an untagged write from ANOTHER document.** A backup restore
(`settings/actions.ts`) or a legacy migration in another tab replaces the blob without a version, so
the stored version stays this document's last one and nothing tells this document its record is
false. An older flight of this document that lands afterwards comes back `superseded` and declares
its send ledger durable, while the disk holds the restore. It needs a restore in a second tab of the
same account, during this tab's in-flight checkpoint. It is left open, rare and named: the cure is
for every write to carry a version (the restore included), which is the version guard's own
follow-up, not this fix's.

**One line per refusal.** The guard's line names the refused version, the stored one, and what this
document last wrote. `writeCheckpoint` rejects typed (`MlsStateWriteRefusedError`) and says nothing
more, and the persister no longer repeats a typed refusal. A caller whose consequence is its own
still says so: `externalJoin`'s fork accusation, and the rotation's abort.

**The rotation persists first** (`BaseMlsService.rotateDeviceIdentity`). The fresh identity is
loaded and checkpointed before anything shared moves: the id in `localStorage`, the send ledger and
the old device's server row. On a refusal, another document wrote this account's state after this
one loaded. Nothing shared moves, the old device is not deleted (the other document may be serving
it), and the refusal propagates.

**What is left in memory is ENDED, never rolled back.** The fresh client is already loaded, so
restoring only the ids would run a groupless client under the revoked id. The round's caller logs
and carries on, so every later round would rotate again, and once this tab's counter passed the
other's the fresh state would be written next to the old stored id. So the ids stay the fresh ones,
agreeing with the client, and each caller ends the holder:

- **init** throws; the login maps it to a typed `LoginFailure` (`state_written_by_another_tab`,
  "close the other tabs") and releases its client;
- **the revocation round** reloads the document (`endDocumentAfterRefusedRotation`), the same proof
  the tab promotion relies on: a reload is what provably re-reads the disk.

**The refusal first LATCHES this document's writes** (`stateWritesEnded`). The version guard cannot
do it: it orders by counter alone and does not know whose blob it holds. A rotation refused as a
`collision` (same version) has its very next capture tagged one above the stored one, and that
capture is written; refused stale by one, the next collides and the one after is written. A reload
does not stop the page either - it runs until the next response commits, seconds on a slow
network - and a persister flight (which raises its dirty flag again after each failure), the
session watchdog's checkpoint or the burn's can land in between. So from the refusal on,
`persistCheckpoint` and `changeDeviceKey` - the two seams every write of a live client passes -
refuse typed (`MlsStateWriteRefusedError('ended')`). The latch is never cleared: the document is
ended, and the next login builds a new client (`mlsHolder.reset`).

**The latch decides AT THE PUT, and the refusal sets it there.** A check when a write starts is not
one: a checkpoint captures, seals off the main thread, and waits for the device-key gate and the
database, and neither the rotation's own checkpoint nor the watchdog's goes through the persister's
single flight. So a flight could pass the start check, capture the fresh client one version above
the other document's and still be sealing when the rotation's write was refused - then land. The
latch is therefore handed to the write (`MlsStateWriteLatch`, `utils/hex.ts`) and read inside its
IndexedDB transaction, in the same synchronous step as the guard's verdict and the put; and the
rotation's write (`endsDocumentOnRefusal`) sets it in the very transaction that refuses it.
IndexedDB serialises read-write transactions on one store, so every later write of this document
sees it. The start check stays, so an ended document captures nothing. Native has no version guard
and never refuses, so only the start check applies there.

**The latch is said ONCE.** The rotation's `error` line says every later write is refused; the
refused writes themselves are silent, typed, and the persister repeats nothing. A device-key re-seal
refused as `ended` is silent too; refused by the guard, it still says which outcome kept the old key.

**The reload is bounded by a count, never a clock.** The page it starts logs in again, and every
login path asks the server whether the stored id is revoked and wipes it if so, so one reload
normally ends it. That question answers `false` when the server is unreachable, though, and a page
that then reaches the server while another document keeps writing would rotate, be refused and
reload again. So at most two such reloads per tab (`sessionStorage`, which a reload keeps -
`refusedRotationReloads.ts`) with no key package round PUBLISHED in between: any round that
publishes resets the count - an ordinary login's, a healed page's, a landed rotation's - and so does
the session's end (`tearDownLiveSession`, sign-out and revocation alike), so a sign-in after a
sign-out in the same tab never inherits a run; the factory wipe empties `sessionStorage` whole. The
key is NOT per account: every exit of an account passes that teardown, and a per-account key would
have to join `accountLocalKeys.ts`, which is the `localStorage` sweep of an account deletion. A
successful init does NOT reset it, because in that
loop every init succeeds; it is the round after it that meets the revocation, so an init reset
would keep the count below the bound for ever. Past the bound the page is not reloaded: it stays
latched, writes nothing, says so at `error`, and shows the member a PINNED toast
(`showPinnedToast`, `mls_page_ended_other_tab_writing`: close the other tabs, then reload) with a
reload button and no close button - closed, it would leave a page that saves nothing and looks alive.

**One accusation per event.** The init path printed three lines for one refusal: the guard's `warn`,
the rotation's `error`, and the login's `[INIT] Login failed` at `error`. The rotation's line is the
one that knows which id stayed stored and that nothing shared moved, so it keeps `error`; the guard
keeps its `warn` (it names both versions); `state_written_by_another_tab` joined
`isExpectedLoginOutcome`, so the login narrates it at `warn` instead of accusing it a second time.

**What the reload costs the member.** The chat composer's text is plain component state
(`MainChatPage.svelte`, `messageText`) and is lost, exactly as on the tab-leader promotion and
demotion reloads, which already accept it. A message already sent is in the durable outbox and is not
lost. A post or a comment being written is not lost: their drafts persist in `localStorage`
(`postComposerDraft.ts`, `postCommentDraft.ts`).

Pinned by `hex.mlsVersion.test.ts` (superseded versus stale, untagged writes; a refusal as
`collision` or stale by one that ends the document makes the next queued write `ended`),
`WebMlsService.changeDeviceKey.test.ts` ("WebMlsService.writeCheckpoint": the latch handed to the
write, `ended` rejects; a re-seal refused as `ended` logs nothing), `mlsStatePersister.test.ts` (a refused checkpoint adds no line),
`BaseMlsService.externalJoin.test.ts` (no fork accusation for an own-document stale write, one for a
foreign one), `BaseMlsService.deviceRevoked.test.ts` and `WebMlsService.legacyMigration.test.ts`
(the refused rotation ends the document on the revocation path, and only for a refusal; a flight
already sealing when the rotation is refused is refused at its put; after the refusal no later
checkpoint, persister flight or re-seal is written, and only one line is printed; the reload bound,
its toast, and its reset by a published round), `refusedRotationReloads.test.ts` and
`signOutEndsLiveSession.test.ts` (the session's end clears the count),
`ToastContainer.svelte.test.ts` (a pinned toast has no close button), `savedStateFailure.test.ts` (the typed login
failure), `loginErrors.test.ts` (narrated, not accused). Each was mutation-checked.

### A history replay's markers wait for the checkpoint that holds it (2026-10-21)

A history replay returns a commit thunk (`MlsReplayCommit`, `utils/chat/history.ts`) that writes
its Redis stream cursor, seen-ciphertext set and retry counters. It must run only once the ratchet
advance the replay made is on disk: a cursor ahead of the state skips, on the next cold replay,
frames the restored state never applied - the `wrong-epoch` / epoch-gap class, and the direction
`commitPendingHistoryMarks` calls unsurvivable.

**Until 2026-10-21 it ran after `endBulkIngest` resolved, and four comments said that was after the
flush. It was not.** `BaseMlsService.endBulkIngest` awaits every observer, but the persister's
`onBulkIngestEnd` STARTS the checkpoint and returns (durability must not gate delivery, section 8),
and a window closing inside another one - a replay inside a live drain - returns at depth > 0 with
no checkpoint at all. So the markers led the state by one checkpoint (~100 ms web, seconds on a big
native state) on every shipped build. Found by reading, never measured in the field.

**Now `withMlsBulkIngest` (`mls-client/mlsBulkIngest.ts`) owns the ordering.** It takes the commit
as an argument and:

1. marks the state dirty AFTER `fn` resolved (the replay's session has committed its ratchet) and
   BEFORE the window closes, so the outermost close's own checkpoint is the one that covers it - no
   second write;
2. closes the window, returns `fn`'s value at once - the caller draws its page without waiting
   for the disk;
3. chains `persister.flushEncrypted()` and runs the commit when it resolves. By the contract of the
   subsection above, that promise resolves only once a checkpoint that started after the mark has
   landed: the dirty flag is cleared only by starting a checkpoint, and a failed one raises it again.
   Nested inside a drain, the flush starts its own checkpoint.

**What "landed" means, exactly.** The commit runs only when `fn` returned something to commit, the
mark came after it, the flush resolved, AND that checkpoint's state is on disk: on web, `written`, or
`superseded` by this document's own later capture, while `stale` and `collision` reject typed (the
subsection above, "A web checkpoint resolves only when its state is on disk"). A typed refusal adds
no line here: the guard has said it once.

**A failed checkpoint rejects the flush and the commit never runs**: the markers stay behind the
state, the survivable direction (a re-walk of frames already seen). No persister registered is a
defect upstream (the pipeline registers before the restore can replay) and is logged as an error,
markers withheld. No clock anywhere: termination is the checkpoint promise, which settles.

**What it costs, stated.** One extra checkpoint per replay that closes inside a live drain, because
that close starts none; a replay that fetched nothing returns `undefined` and owes none. And the
markers land LATER than they did: the restore's commits run once the phase's checkpoint lands,
after `restore` has returned, so a conversation opened meanwhile probes the OLD cursor and re-walks
from it. That re-walk is idempotent - the frames it meets again are in the in-memory seen set.

**The thunk no longer writes the seen set.** That set is the LIVE one live delivery shares, so the
thunk's write also wrote every mark live delivery made while the covering checkpoint was sealing:
a live commit's fingerprint durable before the checkpoint holding its epoch, and a kill there made
the cold replay skip that commit, move the cursor past it, and fail every later frame `wrong-epoch`
into a forced re-Welcome. The walk's own marks need no such write: each is registered pending
before the helper marks the state dirty, so the covering checkpoint's `commitPendingHistoryMarks`
snapshot holds every one. The thunk keeps the cursor and the retry counters.

Rejected: awaiting the checkpoint in the persister's `onBulkIngestEnd` for persist-only windows.
`endBulkIngest` swallows observer failures, so a failed checkpoint could not reach the caller
without changing that seam, the nested close would still start nothing, and the selected
conversation's page would be drawn only after the disk answered (8 s on a cold web client). Also
rejected: the persister running registered thunks after a later checkpoint - the same proof with
more state to own (registration, logout, two replays of one group).

Pinned by `mlsBulkIngest.test.ts` (the real persister as observer: before the checkpoint lands, a
failed checkpoint, a version-guard refusal, a close inside a live drain, a checkpoint already
running, nothing to commit; and no persister) and `history.checkpointBoundMarks.test.ts` ("a LIVE
mark made while the covering checkpoint seals is not made durable by the thunk").
