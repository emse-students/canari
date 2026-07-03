# MLS protocol

Canari implements end-to-end encryption using **MLS (Messaging Layer Security, RFC 9420)**. All encryption and decryption happens inside a **Rust/OpenMLS** WASM module (browser) or a Tauri native binary (desktop/mobile). The server stores and routes only ciphertext — it never sees plaintext.

**Living docs** (do not archive, actively updated):
- `docs/AUDIT-MLS-2026-06.md` — ongoing audit pass, bugs tracked by ID
- `docs/MLS_DESYNC_PREVENTION.md` — desync root causes and countermeasures
- `docs/MLS_RECOVERY_LADDER.md` — step-by-step recovery ladder (welcome_request -> reboot)

## Key properties

| Property | Value |
|---|---|
| Protocol | MLS RFC 9420 |
| Cipher suite | MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 |
| Forward secrecy | Per epoch (key ratchet on every commit) |
| Post-compromise security | Devices can be removed and re-added |
| Server role | Routing + persistence of encrypted blobs only |

## Non-negotiable invariants (post-2026-06 rewrite)

1. `getLocalGroups()` is the sole source of truth for group state.
2. Every message is ACK'd exactly once.
3. No in-memory state machines (no recovery Sets/Maps).
4. Single recovery path, two steps: `welcome_request` (30s timeout) → `reboot`.
5. Successor claim is atomic (CAS). Unchanged from pre-rewrite.

## Source files

### Frontend (SvelteKit)

| File | Role |
|---|---|
| `frontend/src/lib/services/WebMlsService.ts` | WASM MLS client (browser) |
| `frontend/src/lib/services/TauriMlsService.ts` | Tauri native MLS client (desktop/mobile) |
| `frontend/src/lib/services/IMlsService.ts` | Interface shared by both |
| `frontend/src/lib/mlsService.ts` | Factory: picks Web or Tauri at runtime |
| `frontend/src/lib/composables/useChatSession.svelte.ts` | Login, reconnect, device sync orchestration |
| `frontend/src/lib/utils/chat/connection.ts` | WS message handler, epoch recovery, Welcome processing |
| `frontend/src/lib/utils/chat/actions.ts` | `processPendingInvitations`, `discoverMissingGroups`, `handleWelcomeRequest` |
| `frontend/src/lib/utils/chat/history.ts` | History replay (Redis Stream fetch + MLS decrypt) |
| `frontend/src/lib/utils/chat/conversations.ts` | Conversation loading, deduplication, type detection |
| `frontend/src/lib/utils/chat/messaging.ts` | `sendChatMessage`, reactions, edits, deletes |
| `frontend/src/lib/utils/chat/messageUtils.ts` | `appMsgToEnvelope()` - unified AppMessage -> MessageEnvelope decoder |
| `frontend/src/lib/envelope.ts` | `MessageEnvelope` union type (text/media/system) + serialization |
| `frontend/src/lib/proto/codec.ts` | Protobuf encode/decode + `mediaKindToType` |
| `frontend/src/lib/types/index.ts` | Central types: `Conversation`, `ChatMessage`, `MessageReference`, `AddMessageToChatOptions` |
| `frontend/mls-wasm/` | Rust WASM bindings (OpenMLS) |
| `frontend/mls-core/` | Shared Rust MLS logic |

### Backend (NestJS - chat-delivery-service, port 3010)

| File | Role |
|---|---|
| `apps/chat-delivery-service/src/app.controller.ts` | All MLS HTTP endpoints (~40 routes) |
| `apps/chat-delivery-service/src/entities/` | TypeORM entities |

### Gateway (Rust/Axum - chat-gateway, port 3000)

| File | Role |
|---|---|
| `apps/chat-gateway/src/main.rs` | WebSocket routing, presence, pub/sub |

## Data model

### Entities (chat-delivery-service)

| Entity | Purpose |
|---|---|
| `KeyPackage` | Static fallback key package per device (1 per device) |
| `OneTimeKeyPackage` | One-time prekeys (OTKP), consumed on invite |
| `Group` | Group metadata (name, isGroup, epoch) |
| `GroupMember` | User <-> group membership |
| `DeviceGroupMembership` | Per-device state machine (`pending` / `active` / `removed`) |
| `QueuedMessage` | Pending messages for offline devices |
| `PinVerifier` | PBKDF2 verifier to detect PIN mismatch across devices |
| `PushToken` | FCM push token per device |
| `RevokedDevice` | Revoked device IDs (triggers resetRequired on next login) |

### DeviceGroupMembership state machine

```
pending --(add commit + Welcome sent)--> active
active --(device removed / reboot)--> removed
removed --(re-add)--> pending
```

Note: prior to the 2026-06 rewrite the states were `pending / welcome_sent / welcome_received / stale`. The simplified model above is current.

## API endpoints (chat-delivery-service)

All routes require `X-User-Id` header (injected by Nginx `auth_request`).

### Device management

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/register-device` | Register static key package |
| POST | `/api/mls/register-device/prekeys` | Bulk-upload one-time prekeys |
| GET | `/api/mls/devices/:userId` | Fetch all devices for a user |
| DELETE | `/api/mls/devices/:userId/:deviceId` | Delete a device (all memberships + KPs) |
| PATCH | `/api/mls/devices/:userId/:deviceId/metadata` | Update device name/OS/version |
| GET | `/api/mls/devices/:userId/:deviceId/prekeys/count` | Count remaining OTKPs |
| DELETE | `/api/mls/devices/:userId/:deviceId/prekeys` | Purge all OTKPs for device |

### Group management

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/groups` | Create group |
| GET | `/api/mls/groups/:groupId` | Get group metadata |
| PATCH | `/api/mls/groups/:groupId` | Rename group |
| DELETE | `/api/mls/groups/:groupId` | Delete group |
| POST | `/api/mls/groups/:groupId/members` | Register user as member |
| GET | `/api/mls/groups/:groupId/members` | List group members |
| DELETE | `/api/mls/groups/:groupId/members/:userId` | Remove member |
| POST | `/api/mls/groups/:groupId/reset` | Trigger group_reset broadcast |
| POST | `/api/mls/groups/:groupId/reset-epoch` | Reset epoch counter |
| GET | `/api/mls/users/:userId/groups` | List all groups for a user |

### Messaging

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/send` | Send encrypted message/commit |
| POST | `/api/mls/welcome` | Deliver Welcome to device |
| GET | `/api/mls/messages/:userId/:deviceId` | Fetch pending messages |
| POST | `/api/mls/messages/ack` | Acknowledge messages |
| POST | `/api/mls/commit` | Validate commit epoch |

### Device sync / invitation

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/invitations/status` | Upsert DeviceGroupMembership |
| GET | `/api/mls/invitations/pending/:userId/:deviceId` | Invitations to process |
| GET | `/api/mls/device-memberships/:userId/:deviceId` | All memberships for device |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId/:groupId` | Delete one membership |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId` | Delete all memberships |
| POST | `/api/mls/kick-stale-device` | Kick stale leaf from group |
| POST | `/api/mls/welcome-request` | Broadcast welcome_request signal |
| POST | `/api/mls/add-lock` | Acquire distributed add-lock |
| DELETE | `/api/mls/add-lock` | Release add-lock |

### Auth / misc

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/security/pin-check` | Validate/register PIN verifier |
| POST | `/api/mls/push/register` | Register FCM push token |
| DELETE | `/api/mls/push/unregister/:deviceId` | Deregister push token |
| GET | `/api/mls/history/:groupId` | Redis Stream history (incremental) |

## Scenarios

### First login (new device)

1. `login()` loads MLS state from IndexedDB -> none found -> `freshStart = true`
2. `mlsService.init(userId, pin, undefined)` -> WASM initialized with new identity
3. `generateKeyPackage(pin)`:
   - `freshStart = true` -> DELETE stale OTKPs from server
   - Generate fresh static KP + pool of 50 OTKPs (web) / 200 (Tauri)
   - Save WASM state to IndexedDB
   - POST `/api/mls/register-device` (static KP)
   - POST `/api/mls/register-device/prekeys` (pool)
4. `initializeConnection()`:
   - Open WebSocket
   - `fetchPendingMessages()` -> process any queued Welcomes/commits via `enqueueMessage`
   - Check `getDeviceMemberships()` -> `pending` -> send `welcome_request`
5. `discoverMissingGroups()` -> find server groups with no local conversation -> create stubs, send `welcome_request`

### Starting a direct conversation

1. Creator: `createRemoteGroup(name, isGroup=false)` -> server returns `groupId`
2. Creator: `createGroup(groupId)` in WASM
3. Creator: `fetchUserDevices(peerId)` -> get peer's key packages
4. Creator: `addMembersBulk(groupId, devices, excludeDeviceIds)` -> one staged transaction (C7-A): stage the Add, validate the epoch (`POST /api/mls/commit`), merge on accept and broadcast the commit / roll back on reject. Returns `{ welcome, ratchetTree, addedDeviceIds, skippedDeviceIds }` (the ratchet tree is exported post-merge).
5. Creator: `sendWelcome(welcome, peerId, groupId, deviceId, ratchetTree)` -> POST `/api/mls/welcome`
6. Creator: `registerMember(groupId, peerId)` + `registerMember(groupId, userId)`
7. Peer: Welcome arrives via WS or pending queue -> `processWelcome(bytes, ratchetTree)` -> group joined in WASM
8. Peer: `registerMember(groupId, userId)` + `updateInvitationStatus(..., 'active')`
9. Peer: `saveState(pin)` -> persisted to IndexedDB

### Sending a message

1. `sendChatMessage()` in `messaging.ts`
2. Optimistic UI: message added with `status: 'sending'`
3. `mlsService.sendMessage(groupId, appMessageBytes)` -> WASM encrypts -> POST `/api/mls/send`
4. Gateway broadcasts to all group members' WebSocket connections
5. On success: message status patched to `'sent'`; on error: `'error'`

### Receiving a message

1. WS frame arrives -> `enqueueMessage()` -> serialized queue
2. `processQueue()` calls `messageCallback(sender, bytes, groupId, isWelcome, ratchetTree, isCommit)`
3. `connection.ts` handler:
   - Known group + `isReady`: `processIncomingMessage(groupId, bytes)` -> decrypt -> dispatch by type
   - Known group + `!isReady`: buffer, then replay after Welcome
   - Unknown group + `isWelcome`: `processWelcome()` -> create conversation -> replay history
   - Unknown group + not Welcome: buffer in `pendingGroupMessages` map

### New device added to existing account

1. New device logs in -> no MLS state -> `freshStart = true`
2. Purges stale OTKPs -> publishes fresh KPs
3. `getDeviceMemberships()` -> empty -> send `welcome_request` for each user group
4. Online devices receive `welcome_request` via WS -> `handleWelcomeRequest()`:
   - Acquire add-lock
   - `addMember(groupId, newDeviceKP, excludeDeviceIds)` -> staged transaction (validate + merge + broadcast) -> `{ welcome, ratchetTree }`
   - `sendWelcome()`
   - `updateInvitationStatus(..., 'active')`
5. New device receives Welcome -> joins group -> saves state

### Epoch recovery (diverged state)

Triggered when `processIncomingMessage` fails with epoch-related errors:

| Error | Condition | Recovery |
|---|---|---|
| `TooDistantInThePast` / `CiphertextGenerationOutOfBounds` | Ratchet key consumed | ACK silently (irrecoverable) |
| `msg_epoch < group_epoch` | Stale message (already processed) | ACK silently |
| `msg_epoch > group_epoch` | Local state is behind | `forgetGroup()` + `requestReAdd()` |
| `SenderDataDecryption` | Sender secrets diverged | `forgetGroup()` + `requestReAdd()` |
| `WrongEpoch` | No epoch numbers | ACK silently |

`requestReAdd(groupId)`: sends `welcome_request` -> 30s timer -> if no Welcome received -> `reboot()` (CAS + inviteMembers + migrateConversation).

### Group reset

When no automatic recovery is possible (e.g. all devices diverged):

1. Any device calls `mlsService.sendGroupReset(groupId)` -> POST `/api/mls/groups/:id/reset`
2. Server resets all `DeviceGroupMembership` to `pending`, resets epoch
3. Server broadcasts `group_reset` WS event to all group members
4. Each client: `forgetGroup(groupId)` + marks conversation `isReady: false`
5. The triggering device creates the group fresh and invites all members

### Reconnect after network loss

1. `scheduleReconnect()` -> exponential backoff (1s, 2s, 4s, 8s, 16s, 30s)
2. `attemptReconnect()`:
   - `mlsService.connect(token)` -> new WebSocket
   - `fetchPendingMessages()` on WS open
   - `processDeviceInvitationsLocally()` -> re-invite pending devices
   - `discoverMissingGroups()` -> delete local orphans, send `welcome_request` for missing

### Orphan cleanup (reconnect / login)

`discoverMissingGroups()` cross-checks local conversations against the server's group list:
- Groups on server but missing locally -> create stub + send `welcome_request`
- Groups locally but absent from server -> `forgetGroup()` + delete from DB
- Channel conversations (`channel_*`) are never deleted (different encryption scheme)

## Message queue architecture

```
WebSocket frame         fetchPendingMessages()
       |                         |
       v                         v
enqueueMessage()      enqueueMessage()
       |                         |
       +------------+------------+
                    v
             messageQueue[]
                    |
             processQueue()  <-- serialized, one message at a time
                    |
             messageCallback()
                    |
             connection.ts handler
                    |
       processIncomingMessage() / processWelcome()
```

**Welcome priority**: Welcome messages are unshifted to the front of the queue. Non-Welcome messages for groups with a pending Welcome are buffered in `pendingWelcomeGroups` and replayed after the Welcome completes.

**TauriMlsService** uses a `callbackLock` promise chain so `fetchPendingMessages` and `processQueue` never call the Rust layer concurrently.

## Key packages

### Static fallback key package

- Generated on every `generateKeyPackage()` call.
- Stored server-side as the device's main KP.
- Used when all OTKPs are exhausted.

### One-time key packages (OTKP / prekeys)

- Pool of 50 (web) / 200 (Tauri) replenished on connect. Target: 20, threshold: 5.
- Atomically consumed by inviting devices.
- On fresh start: old OTKPs have no matching private keys -> purged via `DELETE /api/mls/devices/:userId/:deviceId/prekeys` **before** generating new ones.

## Credential mismatch recovery

If saved WASM/Rust state embeds a different device ID than what's in localStorage (after localStorage clear or reinstall):

1. `init()` throws `"identity mismatch"` / `"Credential identity"`
2. Discard stale state; generate new device ID
3. `deleteDevice(userId, oldDeviceId)` -> cleans up server registrations
4. Proceed as fresh start (OTKP purge + new KP registration)

## History replay

`replayConversationHistory()` in `history.ts`:

1. Load `lastStreamId` from localStorage (incremental - avoids re-processing consumed ratchet keys).
2. Fetch Redis Stream from `/api/mls/history/:groupId?after=<streamId>`.
3. For each message: use Redis Stream ID as deduplication fingerprint.
4. `processIncomingMessage()` -> decrypt -> `appMsgToEnvelope()` -> dispatch.
5. Irrecoverable errors (`CannotDecryptOwnMessage`, `WrongEpoch`, `SecretReuseError`) -> add to seen fingerprints -> skip.
6. Save `lastStreamId` for next fetch.

## Multi-tab leadership

`initTabLeadershipAsync()` uses a `BroadcastChannel` + heartbeat to elect a single leader tab. Only the leader tab opens the WebSocket and runs `discoverMissingGroups`. Follower tabs skip `initializeConnection()` entirely.

## Bugs fixed by the 2026-06 rewrite

| Bug ID | Description | Fix |
|---|---|---|
| S2 | Static fallback rotation | Rotation inside `replenishKeyPackages` |
| S5 | Stale `lastKnownState` passed to worker | Fresh state passed at each generation |
| C1 | Ambiguous null `ProcessResult` | Typed `ProcessResult` |
| C2 | False positive null counting | Removed |
| C3 | Poison Pill on transient failure | Removed |
| C4 | Orphan group CAS race | Retry cleanup in catch |
| C5 | `deleteAll` before generate (wrong order) | Generate first, delete after |
| C7 | Buffer drop silently | 10s buffer + explicit ACK |
| C8 | Migrate without dedup | Check `conversations.has(to)` |
| R1 | Watchdog vs Welcome race | Timer cancelled on WASM ok |
| R2 | Insufficient coalescing | `timers.has(groupId)` gate |
| R3 | Double `welcome_request` in two-pass | Single pass with `seen` Set |
| R4 | `addMembersBulk` without epoch | `runCommitTransaction` stage->validate->merge |
| R5 | Silent add-lock failure | 2s retry |

## Earlier bug fixes (pre-rewrite)

| Commit | Fix |
|---|---|
| `8cd8d94` | Orphan group cleanup: `discoverMissingGroups` deletes local groups absent from server |
| `851f37a` | Welcome callback overwrite: removed duplicate `onWelcomeRequest` from `connection.ts` |
| `851f37a` | Welcome buffer recovery: re-queue buffered messages when Welcome throws |
| `851f37a` | `WebMlsService` credential mismatch recovery (mirror of TauriMlsService) |
| `851f37a` | `WebMlsService` OTKP purge on fresh start + `DELETE /prekeys` backend endpoint |
| `bccd872` | Remote reactions not rendering; delete/edit reactivity (Svelte 5 `conversations.set()`) |
| `7abba95` | `addMessageToChat` positional API -> options object (`messageId`, `replyTo` were silently discarded) |
| `2009dd4` | Centralised `MessageReference` / `AddMessageToChatOptions`, unified `appMsgToEnvelope()` decoder |
| `2654acb` | Remove legacy fallbacks (base64 proto, old JSON format, plain-text) |
