# MLS desync prevention

Tactics used to keep **server routing / epoch tracking**, **OpenMLS group state**, and **delivery order** aligned. Pair with [`mls-recovery-ladder.md`](mls-recovery-ladder.md) for what happens _after_ a fault is detected.

Run the MLS service and call-site suites in `frontend` after changing **`runCommitTransaction`** or the staged commit primitives (`stageAddMembers` / `mergePendingCommit` / `clearPendingCommit` / `exportRatchetTree`).

## Ordered tactics (by layer)

### 1. Server - epoch-gated commits

- **`POST /api/mls/commit`** — `baseEpoch` must match the group row **`activeEpoch`** (except fast-forward when `activeEpoch === 0`). A **Redis lock** (`mls:commitlock:{groupId}`) serializes concurrent validators so two devices cannot both advance from the same epoch. On success, the commit bytes are stored in the commit-log and **`activeEpoch ← baseEpoch + 1`** atomically, then fanned out. Rejects: **`epoch_mismatch`**, **`concurrent_commit`**. Source: `app.controller.ts` → `validateCommit`.

### 2. Server - coordinated reset and bootstrap

- **`POST /api/mls/groups/:groupId/reset`** (**group_reset**) — Sets memberships to **pending**, **`activeEpoch = 0`**, clears Redis **`group:members`**, notifies clients (WebSocket + queued offline rows). Prevents forked MLS sessions from diverging without a shared line in the sand.

- **`POST /api/mls/groups/:groupId/claim-bootstrap`** / **`GET …/bootstrap-info`** — **Optimistic lock** on **`bootstrapVersion`** so only one device wins re-creation of a group.

### 3. Server - add-member races

- **`POST/DELETE /api/mls/add-lock`** — Redis lock **`mls:addlock:{groupId}`** so only one inviter runs **add member + Welcome** at a time for that group. Used from **`processPendingInvitations`** and discovery re-bootstrap.

### 4. Client - one staged commit regime (ADD + REMOVE)

- **`runCommitTransaction(groupId, stageFn, opts)`** in **`BaseMlsService`** — the single primitive behind **every** structural commit. Under the MLS lock: stage the commit WITHOUT merging (`stageAddMembers` / `stageRemoveMembers*`), read the current **pre-merge** epoch (`freshEpoch`), **`validateCommitEpoch(groupId, baseEpoch)`**, then on accept **`mergePendingCommit`** + broadcast (and **`exportRatchetTree`** for an ADD Welcome), on reject **`clearPendingCommit`** and throw. Because the merge happens only after the server accepts, a rejected commit never advances the local epoch — the whole class of "sender fork" desyncs disappears. `baseEpoch` is the raw current epoch (no `-1` formula: nothing is merged before validation). The platform primitives (`stage*` / `merge` / `clear` / `exportRatchetTree` / `freshEpoch`) are the only pieces that differ between WASM (`WebMlsService`) and native (`TauriMlsService`).

- **Tauri** — **`_epochByGroupId`** + **`refreshEpochCache`** keep **`getEpoch()`** meaningful for validation and UI; `freshEpoch` reads the authoritative pre-merge epoch via `obtenir_epoch`; **`forgetGroup`** clears the cache.

### 5. Client - message ordering and gaps

- **Queue priority (Tauri)** — **`group_reset`** control → **Welcome queue** → **application queue** so resets and welcomes are applied before ciphertext that assumes a joined epoch.

- **Rust / WASM epoch gap** — **`frontend/mls-core`** (and Tauri path) detect **message epoch > group epoch** and fail fast so the caller can run **gap recovery** instead of consuming ratchet material incorrectly.

- **Commit-log replay (rung 1)** — on that gap, the pipeline (`setupMessageHandler` → `attemptCommitReplay`) fetches the missed ordered commits from the server commit-log (**`GET /api/mls/commits/:groupId?sinceEpoch=N`**, written atomically with the epoch advance in **`POST /api/mls/commit`**) and re-applies them to catch the epoch up **without dropping state**. Only a below-floor (pruned) or unapplicable commit falls through to the destructive rung-2 forget + re-Welcome. See [`mls-recovery-ladder.md`](mls-recovery-ladder.md) step 4.

- **`connection.ts`** — Rung-2 fallback: stale decrypt / epoch error patterns can trigger **`forgetGroup`** + **`sendReinviteRequest`** when local epoch is behind the message and rung-1 replay could not catch up (see `[RECOVER]` / `[GAP]` logs).

### 6. Client - discovery re-bootstrap (stale placeholder)

- **`discoverMissingGroups`** (**`actions.ts`**) — **`sendGroupReset`** must succeed **before** **`forceCreateGroup`** + commits; otherwise **`epoch_mismatch`** would return. **`acquireAddLock`** reduces duplicate bootstraps. **`epoch_mismatch`** after reset → **`forgetGroup`** + retry path.

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
- **Not-overtaken** (`installUnlessOvertaken` on web, the unpersisted-send watermark in
  `TauriMlsService.reloadStateFromDisk`): refuses a candidate derived before a send this device has
  already made. A generation that moved INSIDE one epoch is invisible to the epoch guard, which is
  why the epoch half alone let this defect run.

The counter is `BaseMlsService.liveMutations`, read at the snapshot and again at the install: a COUNT
rather than a flag, because the question compares two instants rather than asking "recently?".

The send seam feeds it. `sendMessage` is concrete in `BaseMlsService` and carries all three
outbound invariants - wait for catch-up idle, count the mutation, checkpoint it - so a platform
supplies only `encryptForSend`. It became a template method the day the checkpoint was found at TWO
of the EIGHTEEN call sites that reach a send: the other sixteen (read receipts, reactions, edits,
deletes, pins, group control, calls) advanced the ratchet and persisted nothing, leaving `mls.bin`
structurally behind the live client. A rule each caller has to remember is a rule the next caller
will not.

The background handoff is ordered for the same reason: on `hidden` the checkpoint is flushed
**before** `pause_mls_foreground` releases the native guard. Releasing it is what lets a background
JNI engine load `mls.bin` and advance from it, so releasing it first hands that engine a state that
is already behind. The guard expires on its own after ~30 s, so nothing here rests on a clock - the
ordering is the guarantee.

## Verification

| Tactic | What must hold | How we check |
|---|---|---|
| `baseEpoch` formula | Web and Tauri stage the commit then read the pre-merge epoch in `runCommitTransaction` | `messaging.commit-log.spec.ts` |
| Persistence monotonic | Stale encrypted flush cannot lower the stored blob | `hex.mlsVersion.test.ts` |
| Recovery vs prevention | Desync _handling_ (ACK rules, retries) | [`mls-recovery-ladder.md`](mls-recovery-ladder.md) |
| Server commit logic | Locks + `activeEpoch` rules | Code review / `app.controller.ts` |

## Related sources

- [`apps/chat-delivery-service/src/app.controller.ts`](../../apps/chat-delivery-service/src/app.controller.ts) — `validateCommit`, `resetGroup`, `resetGroupEpoch`, add-lock, claim-bootstrap.
- [`frontend/src/lib/services/mlsDesyncPrevention.ts`](../../frontend/src/lib/services/mlsDesyncPrevention.ts) — shared `baseEpoch` helper.
- [`frontend/mls-core/src/lib.rs`](../../frontend/mls-core/src/lib.rs) — epoch gap detection in `process_incoming_message`.
- [`frontend/src/lib/utils/chat/actions.ts`](../../frontend/src/lib/utils/chat/actions.ts) — `discoverMissingGroups`, group_reset ordering.

## See also

- [`mls-recovery-ladder.md`](mls-recovery-ladder.md) — Recovery steps after desync is detected
- [`mls-protocol.md`](mls-protocol.md) — MLS protocol overview, invariants, data model
- [`services/chat-delivery.md`](../services/chat-delivery.md) — Backend commit validation and epoch management
