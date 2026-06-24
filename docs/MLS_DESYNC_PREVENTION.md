# MLS desync prevention

Tactics used to keep **server routing / epoch tracking**, **OpenMLS group state**, and **delivery order** aligned. Pair with [MLS_RECOVERY_LADDER.md](./MLS_RECOVERY_LADDER.md) for what happens _after_ a fault is detected.

Run `npm run test -- --run src/lib/services/desyncPrevention.contract.test.ts` in `frontend` after changing **`commitBaseEpochForValidation`** or **`sendCommit`**.

## Ordered tactics (by layer)

### 1. Server - epoch-gated commits

- **`POST /api/mls/commit`** - `baseEpoch` must match the group row **`activeEpoch`** (except fast-forward when `activeEpoch === 0`). A **Redis lock** (`mls:commitlock:{groupId}`) serializes concurrent validators so two devices cannot both advance from the same epoch. On success, **`activeEpoch ← baseEpoch + 1`**. Rejects: **`epoch_mismatch`**, **`concurrent_commit`**. Guard: **`HeaderAuthGuard`**. Source: `app.controller.ts` → `validateCommit`.

- **`POST /api/mls/groups/:groupId/reset-epoch`** - Sets **`activeEpoch` to 0** when replacing MLS state for the same server `groupId` (re-bootstrap). Guard: **`HeaderAuthGuard`**.

### 2. Server - coordinated reset and bootstrap

- **`POST /api/mls/groups/:groupId/reset`** (**group_reset**) - Sets memberships to **pending**, **`activeEpoch = 0`**, clears Redis **`group:members`**, notifies clients (WebSocket + queued offline rows). Prevents forked MLS sessions from diverging without a shared line in the sand. Guard: **`HeaderAuthGuard`**.

- **`POST /api/mls/groups/:groupId/claim-bootstrap`** / **`GET …/bootstrap-info`** - **Optimistic lock** on **`bootstrapVersion`** so only one device wins re-creation of a group. Guard: **`HeaderAuthGuard`**.

### 3. Server - add-member races

- **`POST/DELETE /api/mls/add-lock`** - Redis lock **`mls:addlock:{groupId}`** so only one inviter runs **add member + Welcome** at a time for that group. Used from **`processPendingInvitations`** and discovery re-bootstrap. Guard: **`HeaderAuthGuard`**.

### 4. Client - same `baseEpoch` on Web and Tauri

- **`commitBaseEpochForValidation(currentEpoch)`** in **`mlsDesyncPrevention.ts`** - Single formula **`max(0, floor(currentEpoch) - 1)`** used by **`WebMlsService.sendCommit`** and **`TauriMlsService.sendCommit`** after reading the post-merge local epoch. Keeps Web/Tauri consistent with **`validateCommit`**.

- **Tauri** - **`_epochByGroupId`** + **`refreshEpochCache`** keep **`getEpoch()`** meaningful for validation and UI; **`forgetGroup`** clears the cache.

### 5. Client - message ordering and gaps

- **Queue priority (Tauri)** - **`group_reset`** control → **Welcome queue** → **application queue** so resets and welcomes are applied before ciphertext that assumes a joined epoch.

- **Rust / WASM epoch gap** - **`frontend/mls-core`** (and Tauri path) detect **message epoch > group epoch** and fail fast so the caller can run **gap recovery** (history fetch / `GAP_QUEUED`) instead of consuming ratchet material incorrectly.

- **`connection.ts`** - Optional recovery: stale decrypt / epoch error patterns can trigger **`forgetGroup`** + **`sendReinviteRequest`** when local epoch is behind the message (see `[RECOVER]` logs).

### 6. Client - discovery re-bootstrap (stale placeholder)

- **`discoverMissingGroups`** (**`actions.ts`**) - **`sendGroupReset`** must succeed **before** **`forceCreateGroup`** + commits; otherwise **`epoch_mismatch`** would return. **`acquireAddLock`** reduces duplicate bootstraps. **`epoch_mismatch`** after reset → **`forgetGroup`** + retry path.

## Verification

| Tactic                 | What must hold                                   | How we check                                       |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------- |
| `baseEpoch` formula    | Web and Tauri use `commitBaseEpochForValidation` | `desyncPrevention.contract.test.ts`                |
| Recovery vs prevention | Desync _handling_ (ACK rules, retries)           | [MLS_RECOVERY_LADDER.md](./MLS_RECOVERY_LADDER.md) |
| Server commit logic    | Locks + `activeEpoch` rules                      | Code review / `app.controller.ts`                  |

## Related sources

- `apps/chat-delivery-service/src/app.controller.ts` - `validateCommit`, `resetGroup`, `resetGroupEpoch`, add-lock, claim-bootstrap.
- `frontend/src/lib/services/mlsDesyncPrevention.ts` - shared `baseEpoch` helper.
- `frontend/mls-core/src/lib.rs` - epoch gap detection in `process_incoming_message`.
- `frontend/src/lib/utils/chat/actions.ts` - `discoverMissingGroups`, group_reset ordering.
