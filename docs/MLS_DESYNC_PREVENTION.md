# MLS desync prevention

Tactics used to keep **server routing / epoch tracking**, **OpenMLS group state**, and **delivery order** aligned. Pair with [MLS_RECOVERY_LADDER.md](./MLS_RECOVERY_LADDER.md) for what happens _after_ a fault is detected.

Run the MLS service and call-site suites in `frontend` after changing **`runCommitTransaction`** or the staged commit primitives (`stageAddMembers` / `mergePendingCommit` / `clearPendingCommit` / `exportRatchetTree`).

## Ordered tactics (by layer)

### 1. Server - epoch-gated commits

- **`POST /api/mls/commit`** - `baseEpoch` must match the group row **`activeEpoch`** (except fast-forward when `activeEpoch === 0`). A **Redis lock** (`mls:commitlock:{groupId}`) serializes concurrent validators so two devices cannot both advance from the same epoch. On success, the commit bytes are stored in the commit-log and **`activeEpoch ← baseEpoch + 1`** atomically, then fanned out. Rejects: **`epoch_mismatch`**, **`concurrent_commit`**. Guard: **`HeaderAuthGuard`**. Source: `app.controller.ts` → `validateCommit`.

### 2. Server - coordinated reset and bootstrap

- **`POST /api/mls/groups/:groupId/reset`** (**group_reset**) - Sets memberships to **pending**, **`activeEpoch = 0`**, clears Redis **`group:members`**, notifies clients (WebSocket + queued offline rows). Prevents forked MLS sessions from diverging without a shared line in the sand. Guard: **`HeaderAuthGuard`**.

- **`POST /api/mls/groups/:groupId/claim-bootstrap`** / **`GET …/bootstrap-info`** - **Optimistic lock** on **`bootstrapVersion`** so only one device wins re-creation of a group. Guard: **`HeaderAuthGuard`**.

### 3. Server - add-member races

- **`POST/DELETE /api/mls/add-lock`** - Redis lock **`mls:addlock:{groupId}`** so only one inviter runs **add member + Welcome** at a time for that group. Used from **`processPendingInvitations`** and discovery re-bootstrap. Guard: **`HeaderAuthGuard`**.

### 4. Client - one staged commit regime (ADD + REMOVE)

- **`runCommitTransaction(groupId, stageFn, opts)`** in **`BaseMlsService`** - the single primitive behind **every** structural commit. Under the MLS lock: stage the commit WITHOUT merging (`stageAddMembers` / `stageRemoveMembers*`), read the current **pre-merge** epoch (`freshEpoch`), **`validateCommitEpoch(groupId, baseEpoch)`**, then on accept **`mergePendingCommit`** + broadcast (and **`exportRatchetTree`** for an ADD Welcome), on reject **`clearPendingCommit`** and throw. Because the merge happens only after the server accepts, a rejected commit never advances the local epoch - the whole class of "sender fork" desyncs disappears. `baseEpoch` is the raw current epoch (no `-1` formula: nothing is merged before validation). The platform primitives (`stage*` / `merge` / `clear` / `exportRatchetTree` / `freshEpoch`) are the only pieces that differ between WASM (`WebMlsService`) and native (`TauriMlsService`). [[C7]]

- **Tauri** - **`_epochByGroupId`** + **`refreshEpochCache`** keep **`getEpoch()`** meaningful for validation and UI; `freshEpoch` reads the authoritative pre-merge epoch via `obtenir_epoch`; **`forgetGroup`** clears the cache.

### 5. Client - message ordering and gaps

- **Queue priority (Tauri)** - **`group_reset`** control → **Welcome queue** → **application queue** so resets and welcomes are applied before ciphertext that assumes a joined epoch.

- **Rust / WASM epoch gap** - **`frontend/mls-core`** (and Tauri path) detect **message epoch > group epoch** and fail fast so the caller can run **gap recovery** instead of consuming ratchet material incorrectly.

- **Commit-log replay (rung 1)** - on that gap, the pipeline (`setupMessageHandler` → `attemptCommitReplay`) fetches the missed ordered commits from the server commit-log (**`GET /api/mls/commits/:groupId?sinceEpoch=N`**, written atomically with the epoch advance in **`POST /api/mls/commit`**) and re-applies them to catch the epoch up **without dropping state**. Only a below-floor (pruned) or unapplicable commit falls through to the destructive rung-2 forget + re-Welcome. See [MLS_RECOVERY_LADDER.md](./MLS_RECOVERY_LADDER.md) step 4.

- **`connection.ts`** - Rung-2 fallback: stale decrypt / epoch error patterns can trigger **`forgetGroup`** + **`sendReinviteRequest`** when local epoch is behind the message and rung-1 replay could not catch up (see `[RECOVER]` / `[GAP]` logs).

### 6. Client - discovery re-bootstrap (stale placeholder)

- **`discoverMissingGroups`** (**`actions.ts`**) - **`sendGroupReset`** must succeed **before** **`forceCreateGroup`** + commits; otherwise **`epoch_mismatch`** would return. **`acquireAddLock`** reduces duplicate bootstraps. **`epoch_mismatch`** after reset → **`forgetGroup`** + retry path.

### 7. Client - persistence write-if-newer (Web/IndexedDB)

- **Monotonic snapshot version** (**`utils/hex.ts`**) - the encrypted MLS checkpoint is written under a **write-if-newer** guard. Every serialized snapshot is tagged (`tagMlsSnapshot`) with an increasing version at the synchronous capture moment; the version rides with the bytes via a `WeakMap` (`propagateMlsSnapshotVersion` across the plain→encrypted step) so the off-thread Argon2 encryption cannot reorder it. **`saveMlsStateEncrypted`** does an IDB read-modify-write and refuses any blob whose version is not strictly newer than the stored **`MLS_STATE_VERSION_KEY`**. This stops a slow encrypted flush (`mlsStatePersister`, worker Argon2) from overwriting a fresher concurrent write (`generateKeyPackage`, main-thread Argon2) - which would silently regress the persisted epoch on the next reload. The in-memory counter is reseeded from the stored version at load (`seedMlsSnapshotSeq`) so a fresh session never emits a version below what is already on disk. Only a plain integer is stored - no groupId/epoch at rest, so privacy is unchanged. Web-only: Tauri persists to the filesystem under its own `mls_bin_write_lock`.

## Verification

| Tactic                 | What must hold                                   | How we check                                       |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `baseEpoch` formula    | Web and Tauri stage the commit then read the pre-merge epoch in `runCommitTransaction` | `messaging.commit-log.spec.ts`  |
| Persistence monotonic  | Stale encrypted flush cannot lower the stored blob | `hex.mlsVersion.test.ts`                          |
| Recovery vs prevention | Desync _handling_ (ACK rules, retries)           | [MLS_RECOVERY_LADDER.md](./MLS_RECOVERY_LADDER.md) |
| Server commit logic    | Locks + `activeEpoch` rules                      | Code review / `app.controller.ts`                  |

## Related sources

- `apps/chat-delivery-service/src/app.controller.ts` - `validateCommit`, `resetGroup`, `resetGroupEpoch`, add-lock, claim-bootstrap.
- `frontend/src/lib/services/mlsDesyncPrevention.ts` - shared `baseEpoch` helper.
- `frontend/mls-core/src/lib.rs` - epoch gap detection in `process_incoming_message`.
- `frontend/src/lib/utils/chat/actions.ts` - `discoverMissingGroups`, group_reset ordering.
