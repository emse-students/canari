# MLS protocol

Canari implements end-to-end encryption using **MLS (Messaging Layer Security, RFC 9420)**. All encryption and decryption happens inside a **Rust/OpenMLS** WASM module (browser) or a Tauri native binary (desktop/mobile). The server stores and routes only ciphertext — it never sees plaintext.

**Living docs** (do not archive, actively updated):
- [`protocols/mls-desync-prevention.md`](protocols/mls-desync-prevention.md) — desync root causes and countermeasures
- [`protocols/mls-recovery-ladder.md`](protocols/mls-recovery-ladder.md) — step-by-step recovery ladder (rung-1 commit replay → rung-2 external join → welcome_request fallback)

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
4. Recovery: rung-1 commit replay for epoch gaps; rung-2 self-service external-commit join for a
   device lacking state (external join replaced the reboot/CAS/successor machinery in Phase 4b),
   with `welcome_request` as the thin fallback when no GroupInfo is stored yet.

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
| `PinVerifier` | Argon2id verifier to detect PIN mismatch across devices |
| `PushToken` | FCM push token per device |
| `RevokedDevice` | Revoked device IDs (triggers resetRequired on next login) |

### DeviceGroupMembership state machine

```
pending --(add commit + Welcome sent)--> active
active --(device removed / group deleted)--> removed
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

`DELETE /devices/:userId/:deviceId` is a full purge (KeyPackages, prekeys, push tokens,
memberships, Redis routing entry) and is irreversible for whatever that device still had in
flight, so `DeviceManagementPanel` gates it behind `showConfirm` - the same treatment a channel
kick gets. The current device has no delete button at all.

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
| GET | `/api/mls/users/:userId/groups` | List all groups for a user |

### Messaging

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/send` | Send encrypted message/commit |
| POST | `/api/mls/welcome` | Deliver Welcome to device |
| GET | `/api/mls/messages/:userId/:deviceId` | Fetch pending messages |
| POST | `/api/mls/messages/ack` | Acknowledge messages |
| POST | `/api/mls/commit` | Submit a commit: validate epoch + store in the commit-log + fan out (one atomic call) |
| GET | `/api/mls/commits/:groupId?sinceEpoch=N` | Rung-1 replay: ordered commits `baseEpoch >= N` to catch up a lagging device |
| GET | `/api/mls/group-info/:groupId` | Latest GroupInfo (external-join base) - membership-gated, returns `{ groupInfo, baseEpoch }` or null |
| POST | `/api/mls/group-info/:groupId` | Refresh the stored GroupInfo (after each commit) - membership-gated, monotonic write-if-newer |

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
| POST | `/api/mls/history-request` | Ask one RANDOM online member to resend the history bundle (after a fresh join); `no_peer_online` if none |
| POST | `/api/mls/add-lock` | Acquire distributed add-lock |
| DELETE | `/api/mls/add-lock` | Release add-lock |

### Auth / misc

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/security/pin-check` | Validate/register PIN verifier |
| POST | `/api/mls/push/register` | Register FCM push token |
| DELETE | `/api/mls/push/unregister/:deviceId` | Deregister push token |
| POST | `/api/mls/push/commits` | PushSecret-authed ordered commits `sinceEpoch` (background in-memory catch-up) |
| GET | `/api/mls/history/:groupId` | Redis Stream history (incremental) |

### Background push commit catch-up (never-opened mobile)

A device added to a group advances the epoch via a commit. A member whose mobile has not been opened
only runs the read-only background push decrypt (`mobile/background.rs::decrypt_push_message`, which
discards commits and never persists), so it stays behind and the newcomer's first message at the new
epoch is an epoch gap -> generic fallback notification. To decrypt at notification time, the FCM/APNs
decrypt-fail path performs a **read-only in-memory commit catch-up**: read the current epoch
(`nativeGroupEpoch`), fetch the ordered commits via `POST /api/mls/push/commits` (PushSecret - the
background path has no JWT), apply them to an ephemeral manager to reach the message epoch, decrypt,
and discard (`decrypt_push_message_with_commits`). It NEVER writes `mls.bin`; the durable state is
caught up later by the foreground commit-log replay. `belowFloor` (commits pruned past retention) ->
no catch-up, the existing worker-retry + fallback stands.

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

Only the bulk commit must stay unique (staged under the add-lock). Everything around it is
plain HTTP and runs in parallel (`groupCreation.ts` / `deliverWelcomes` in `groupActions.ts`):
device fetches across invited users, Welcome deliveries across devices (same blob, order-free),
and `registerMember` deduplicated per user. Group invites surface optimistic "pending" member
rows in the group panel while the flow runs (`pendingGroupInvites` in `useConversations`).
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

`requestReAdd(groupId)`: tries `externalJoin(groupId)` first (fetch the stored GroupInfo -> build a native external commit -> submit under the epoch gate -> merge, or discard + retry on an epoch race); falls back to a single `welcome_request` when no GroupInfo is available. Self-throttled to one attempt per `RECOVERY_TIMEOUT_MS`; the SYNC_WATCHDOG drives the cadence. No reboot/CAS/successor.

**Server-side membership on an external join.** `validateCommit` promotes the committing device's `DeviceGroupMembership` to `active` (and adds it to the `group:members:<groupId>` Redis set) when it has no active row yet. An external commit is the ONE join path with no Welcome, so nothing else creates that row - and recipient resolution filters on `status='active'`. Without the promotion the rejoined device is invisible to routing while believing it is a member: its own sends work, but it receives neither the history bundle it solicits nor any later live message. Idempotent, and skipped for ordinary commits from existing members.

On a successful external join the device also marks its conversation `active` (external join does not go through the Welcome path that normally promotes it) and solicits a `history_request`: a fresh join lands at the current epoch WITHOUT the pre-join history it cannot decrypt on its own, so it asks one online member (picked server-side, single responder) to resend the history re-encrypted at the current epoch via the shared `sendFullHistoryBundle`. History-only, never a re-add.

The **Welcome** join path solicits history the same way (`solicitHistory` in `historySolicit.ts`, called from the joiner's `onWelcomeProcessed` for a genuinely new local conversation). The inviter pushes a bundle on the foreground add path, but its background twin (`send-welcome-and-commit`) does not, so the joiner also asks for it. Solicitation is bounded and receipt-driven: it re-sends on a short backoff (cancelled the moment a `history_bundle` arrives), and the server forwards each call to a RANDOM online member so retries rotate past a backgrounded Android that holds its WebSocket open but cannot process the frame (frozen-online).

The first attempt is deferred by `INITIAL_SOLICIT_DELAY_MS` (~2.5 s) so a self-join peer applies our fan-out external commit before it re-encrypts the bundle - otherwise it would serve the history at its old (pre-commit) epoch, which the joiner (now one epoch ahead) cannot decrypt.

**Request-level timeout / retry (WP-HIST-1 Option C).** `sendHistoryRequest` is online-only: the server returns `no_peer_online` when no responder is reachable, and if the single picked responder is backgrounded or killed the request is silently dropped. To keep the user informed, each `sendHistoryRequest` call is now wrapped in a 30 s response window (`historyRequestPendingStore`).

- If a `history_bundle` arrives in that window, the window closes and nothing is shown.
- If the window elapses without a bundle, the group moves to `pending-offline`; the UI shows `chat_history_request_pending_offline` in the open conversation.
- Up to 3 automatic retries are scheduled (30 s, 2 min, 5 min). A retry also fires immediately when the app returns to the foreground or the network comes back.
- Retries are bounded: after 3 attempts the banner stays visible but no new automatic retry is scheduled until the next online/foreground resume event.
- The pending state is cleared as soon as a bundle arrives (`noteHistoryBundleReceived`).
- No native or backend changes; the `history-request` wire format is unchanged. Option A (full background FCM wake + headless native runtime) remains planned for a future WP.

**Cross-session durability.** The in-session backoff spans only ~3 min; if the only reachable member stays offline for that window, a naive one-shot solicitation is lost forever, because a later session finds the group already in WASM and recovery no longer solicits. To fix this, `solicitHistory` records the group in a persistent `awaiting-history` registry (`awaitingHistoryRegistry.ts`, localStorage, per-user, 30-day give-up horizon), cleared only when a `history_bundle` actually arrives (`noteHistoryBundleReceived`). The connection sync (`syncConnectionAfterWsOpen`) calls `reSolicitAwaitingHistory` on every (re)connect, re-driving a fresh solicitation burst for each still-awaiting local group - so the history is retried across sessions until it lands (or the horizon lapses).

**What the bundle carries.** `serializeForBundle` (`groupActions.ts`) sends, per message: `id`, `senderId`, `content`, `timestamp`, plus `reactions`, `readBy`, `readAt`, `isDeleted`, `isEdited` and `serverTimestamp` when set. Replies need no field of their own - `replyTo` lives inside the serialized envelope, i.e. inside `content`, and travels verbatim. Not carried, because `StoredMessage` does not hold them: `editedAt` (only the `isEdited` flag survives), pins, and system messages - the last two are rebuilt by the stream replay when their events are still in the window.

Reception is in two steps, and the order matters. The add-path (`batchAddMessages`) takes only `{senderId, content, messageId, timestamp}` because `AddMessageToChatOptions` cannot carry read state; the metadata is merged **afterwards**, onto the messages just added *and* onto any already present (that second half is what makes bundle receipts land on our OWN sent messages, previously skipped as duplicates).

**The unread badge is recomputed, never transported.** `ConversationMeta` has no counter, so both recompute sites derive it. The naive rule - "arrived during this replay" - is only a proxy for "not seen yet" and it breaks precisely here: bundle messages are new to this device yet were already read on another one. They say so, because the read receipt we once sent was persisted by the *peer*, who returns our own id in `readBy`. `isUnreadForUser` (`utils/chat/unread.ts`) is the single predicate consulted by both the bundle handler and the startup restore. The bundle handler additionally clamps the result with `Math.min` against the current count, so a conversation the add-path already zeroed (it was open) can never regain a badge. A genuinely new member appears in no `readBy` and therefore keeps the full count until they open the conversation, which zeroes it.

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

## Failing to load a saved state

`loadStateWithKey` can reject three ways. Two are told apart by
`BaseMlsService.classifyStateLoadFailure`; the third is checked first because it looks exactly like
`sealed` and has a completely different answer.

### An envelope older than v0.11.0

Before v0.11.0 the snapshot was sealed `[salt (16) || nonce (12) || ciphertext]` with
Argon2id(PIN, salt). v0.11.x seals `[nonce (12) || ciphertext]` with the PBKDF2 device key, and
shipped no reader for the old envelope - while `CanariDBMls_<userId>` stayed pinned at schema
version 1 and native `mls.bin` carries no version either. Nothing rewrote or dropped those blobs,
so on the first v0.11.x login they fail to decrypt and are indistinguishable from a key rotated
elsewhere. Reported as such, they sent every upgrading user into an old-PIN recovery that could
never succeed.

So on a `sealed` verdict, when the caller supplied `MlsInitOptions.legacyPin` (the PIN just
verified server-side; absent on the biometric and vault paths), the legacy envelope is tried once:

| Platform | Entry point | On success |
|---|---|---|
| Web | `migrateLegacyMlsStateBlob` (`mlsWasmLoader.ts`) - `decrypt_with_pin` then `encrypt_mls_state_blob_with_key` | `_initImpl` reloads from the re-sealed bytes and `saveMlsState`s them |
| Tauri | `legacyPin` forwarded to `initialiser_mls`; `migrate_legacy_state_blob` in `commands/mls.rs` | Rust re-seals and `write_mls_state_blob`s before returning |

Persisting is part of the migration, not a follow-up: a snapshot left in the legacy envelope
replays the conversion at every launch, and any failure in between resurfaces as the same false
"PIN changed on another device". The layout both sides depend on is locked by
`mls-core/tests/legacy_state_envelope.rs` - **if the envelope changes again, ship the reader for
the previous one in the same commit.**

A blob the PIN does not open falls through to the table below, so a genuine rotation still gets
its recovery.

**Opening the envelope says nothing about whose state it is.** A snapshot written before an
interrupted fresh start carries the previous device's credential, so the re-sealed bytes can still
be rejected - with a `mismatch`, not a `sealed`. The verdict is therefore re-read from the
migration's own failure and applied by the normal path below. Doing this from inside the first
`catch` is what let a raw `Credential identity mismatch` escape `init` instead of fresh-starting.

### The two `classifyStateLoadFailure` verdicts

| Verdict | Meaning | Recovery |
|---|---|---|
| `sealed` | The blob would not decrypt (AEAD failure): the account key was rotated on another device. | Honour `MlsInitOptions.noFreshStart`: throw `MLS_LOCAL_STATE_UNDECRYPTABLE` so the caller can offer the old PIN and recover the history intact. |
| `mismatch` | The blob decrypted; its credential names another device (localStorage cleared, reinstall, or an interrupted fresh start). | Fresh start. `noFreshStart` does NOT apply - no PIN can repair an identity, so pausing would strand the user. |

Fresh start, in order:

1. Generate a new device ID and write it to `mls_device_id_{userId}`.
2. `loadStateWithKey(key, undefined)` -> empty client.
3. **Persist immediately** (`saveState` -> `mls.bin` / IndexedDB) - see below.
4. `deleteDevice(userId, oldDeviceId)` -> cleans up server registrations.
5. Continue as a fresh start (OTKP purge + new KP registration).

Step 3 is load-bearing. Without it the new device ID lands in localStorage while the OLD blob
stays in storage, so the next launch mismatches again and mints yet another device - a loop that
produced four device IDs in eight seconds in production, each deleted server-side, none ever
publishing a KeyPackage.

Step 3 is also where a broken save becomes fatal rather than merely logged - see the worker
contracts below.

## Worker message contracts

Three workers carry MLS work off the main thread: `mlsEncrypt.worker` (seal a snapshot),
`mlsCrypto.worker` (warm client for catch-up decryption), `mlsKeyPackage.worker` (key package
generation). Their request/response shapes live in `src/lib/mls-client/mlsWorkerProtocol.ts` and
are imported by **both** ends.

That single module is not tidiness. A `postMessage` argument is structurally typed by whatever the
call site writes, so an object literal built inline is checked by nobody: the v0.11.0 PIN ->
deviceKey rename updated the encrypt worker's destructuring to `deviceKeyB64` and left the sender
posting `pin`. The worker then sealed with `undefined`, wasm-bindgen read `undefined.length`, and
every state save through the worker failed. On the checkpoint paths that rejection was only
logged; on the fresh-start path, which awaits the save (step 3 above), it aborted login with
`can't access property "length", e is undefined`. Same failure mode as an `invoke()` name that
matches no `#[tauri::command]` - **a string or shape crossing a boundary is unchecked unless one
declaration governs both sides.**

`mlsEncryptWorkerSession.test.ts` drives the real worker handler with the real posted message, so a
field renamed on one side alone fails the suite as well as `svelte-check`.

## History replay

`replayConversationHistory()` in `history.ts`:

1. Load `lastStreamId` from localStorage (incremental - avoids re-processing consumed ratchet keys).
2. Fetch Redis Stream from `/api/mls/history/:groupId?after=<streamId>`.
3. For each message: use Redis Stream ID as deduplication fingerprint.
4. `processIncomingMessage()` -> decrypt -> `appMsgToEnvelope()` -> dispatch.
5. Permanent same-epoch errors (`CannotDecryptOwnMessage`, `SecretReuseError`) -> add to seen fingerprints -> skip.
6. Recoverable errors (`epoch-gap` = future frame we are behind; `wrong-epoch`) -> kept **un-seen** so a later load after epoch catch-up can decrypt them. Bounded by a per-ciphertext retry ledger (`history_retry_cipher:*`, cap `MAX_HISTORY_DECRYPT_RETRIES`): a frame that stays undecryptable across that many replay runs is a permanently-undecryptable frame (an external joiner's pre-join / forked-epoch ciphertext), so it is finally marked seen and the cursor advances past it - this stops the per-sync `Sender data decryption error` refetch storm. `epoch-gap` still sets the stale-gap flag (`shouldFlagStaleEpochGap`) so a genuinely stuck-behind group is escalated to forget + re-Welcome.
7. Save `lastStreamId` (and the retry ledger) for next fetch - deferred to the post-checkpoint commit thunk so durable progress never runs ahead of the persisted ratchet.

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
