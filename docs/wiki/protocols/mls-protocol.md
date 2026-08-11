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
| `TooDistantInThePast` / `CiphertextGenerationOutOfBounds` | Ratchet key consumed | ACK, then classify - see below |
| `msg_epoch < group_epoch` | Stale message (already processed) | ACK silently |
| `msg_epoch > group_epoch` | Local state is behind | `forgetGroup()` + `requestReAdd()` |
| `SenderDataDecryption` | Sender secrets diverged | `forgetGroup()` + `requestReAdd()` |
| `WrongEpoch` | No epoch numbers | ACK silently |

#### Why a sender's ratchet goes backwards at all (WP-LOSS-1, 2026-08-06)

The recovery table above is the receiver's side of a defect whose cause is on the SENDER, and the
two were originally reported as separate bugs (WP-FWD-1, "forwarding loses messages"). They are one
defect, and it is deterministic.

The fingerprint is a sender that keeps re-offering the SAME generation:

```
sender    POST /api/mls/send -> 201
receiver  [RUST::DEBUG] Ciphertext generation out of bounds 110  SecretReuseError
receiver  [MLS] Duplicate for <group> - silent ACK
```

Forwarding was never the variable. Two experiments isolate it, neither of which forwards anything:

| Experiment | Result |
| --- | --- |
| Reload, then send three messages | only the FIRST is lost (`out of bounds 110`); a second round immediately after loses nothing |
| Prime the ratchet with a send, wait, reload, send | 300 ms wait: **lost** (generations 118, then 120). 20 s wait: delivered in 694 ms |

**MLS disk writes were deferred, so a reload that beat the checkpoint restored a state behind the
ratchet the sender had already used.** The next message is then encrypted at a generation the
receiver already consumed, and the receiver drops it as a duplicate.

`scheduleOutboundMlsPersist` therefore calls `persistNow()` rather than `scheduleDeferred()`:
encrypting a message checkpoints the ratchet at the point it moved. **An unload hook cannot
substitute** - `pagehide` / `visibilitychange` can only *start* an async save (a worker round trip,
then IndexedDB) and the document is torn down long before it lands, so it is a best-effort extra and
never the guarantee. `persistNow` still merges same-tick calls and stays deferred during a bulk
ingest, so a burst of sends costs one checkpoint.

The invariant this establishes, and it is the general form: **never hand out a ciphertext whose
ratchet advance is not yet durable.** A ratchet that can go backwards is a correctness bug in its
own right - it is also how two live tabs of one device diverge (see [multi-tab
leadership](#multi-tab-leadership)).

Two things this retires permanently, so that neither is re-opened: the load hypothesis (a burst
alone never provokes it - 30 rapid sends are clean), and "forwarding is special".

One trap worth naming: `[MLS] Disk writes deferred` sat on the harness's benign-log list for weeks.
It was the loudest line in the log.

**A consumed generation is not evidence of a duplicate.** `SecretReuseError` /
`CiphertextGenerationOutOfBounds` says only that the generation is spent, and that happens both when
the same frame arrives twice (real-time publish racing the queue or FCM) and when a sender whose
state went backwards encrypts a NEW message at a generation we spent on another one. The first is
benign; the second is a message lost for good on this side, and both used to be dropped in silence.
`inboundFrameLedger.ts` fingerprints every frame processed (in memory, 200 per group), so the two
are separated on the only evidence available - the frame's bytes. A miss logs `LOST frame` and
solicits the **history diff**, which is the single repair for this class: it reads the peer's DURABLE
store, is answered by one elected member, and names messages by id.

There used to be a narrower rung in front of it - `decrypt_failed { withinMs }`, answered from an
in-memory ring of the last five minutes of sent protos. It is deleted, and the reasoning generalises:
a repair that cannot NAME its target can only ask for a period of time, which is a broadcast; and its
one trigger is a sender whose ratchet went backwards, so what it asks that sender to do is re-encrypt
at the same rewound ratchet. Its only mode of success was the sender burning past the receiver's
high-water mark while answering - recovery by exhaustion. Measured on production 2026-08-10: ~450
frames/min across three devices for over ten minutes, repairing nothing. The receiving branch remains
only to IGNORE the event from an older peer. Never `onOutOfSync` either: the plaintext is unrecoverable
whatever we do locally, and a re-add would destroy a valid membership for nothing.

Both platforms run this classifier - the Tauri command surfaces the
error rather than answering `Ok(None)`, which used to discard the diagnosis before TypeScript saw
it. A layer that cannot make a distinction must not make it, and the guard is
`same_epoch_ratchet.rs` rather than a comment.

**And a generation too far AHEAD is the mirror case, with the opposite remedy.**
`SecretTreeError(TooDistantInTheFuture)` means the frame's generation is beyond what OpenMLS will
derive forward (`maximum_forward_distance`), i.e. this device missed a long run of that sender's
frames - which is what an undrainable pending queue produces (WP-PENDING-1). The epochs match on both
sides, so **no commit replay can help**: only a new epoch resets the sender ratchets. It is therefore
classified apart (`generation-gap` in TS, `DecryptErrorKind::GenerationTooFarAhead` in `mls-core`,
both matched BEFORE the generic `Process error:` / `GAP_QUEUED` rule, since the native layer wraps
one string inside the other), never queued in `pending_mls_messages` (it can never be retried), and
escalated at once to `forgetGroup()` + `requestReAdd()` with no threshold - unlike `secret-reuse`,
the group really is broken for us, because every later frame that sender emits in this epoch fails
identically. Read as an epoch gap it produced the worst possible outcome: a replay that applied zero
commits, reported `healed=true` because `epoch >= activeEpoch` was trivially satisfied, and ACKed the
message off the server (WP-PENDING-2).

`requestReAdd(groupId)`: tries `externalJoin(groupId)` first (fetch the stored GroupInfo -> build a native external commit -> submit under the epoch gate -> merge, or discard + retry on an epoch race); falls back to a single `welcome_request` when no GroupInfo is available. Self-throttled to one attempt per `RECOVERY_TIMEOUT_MS`; the SYNC_WATCHDOG drives the cadence. No reboot/CAS/successor.

**Server-side membership on an external join.** `validateCommit` promotes the committing device's `DeviceGroupMembership` to `active` (and adds it to the `group:members:<groupId>` Redis set) when it has no active row yet. An external commit is the ONE join path with no Welcome, so nothing else creates that row - and recipient resolution filters on `status='active'`. Without the promotion the rejoined device is invisible to routing while believing it is a member: its own sends work, but it receives neither the history bundle it solicits nor any later live message. Idempotent, and skipped for ordinary commits from existing members.

That promotion passes **`redeliverMissed: false`**, unlike every other activation. The default replay exists for the Welcome path, where the device was pending while messages were sent to the group and has to be handed the window it missed. An external join has no such window: the device is joining at the CURRENT epoch, so replaying older ciphertexts sends it frames it cannot decrypt, and the history it actually needs comes re-encrypted through the `history_request` below.

On a successful external join the device also marks its conversation `active` (external join does not go through the Welcome path that normally promotes it) and may solicit a `history_request`: a fresh join lands at the current epoch WITHOUT the pre-join history it cannot decrypt on its own, so it asks one online member (picked server-side, single responder) to resend the history re-encrypted at the current epoch via the shared `sendFullHistoryBundle`. History-only, never a re-add.

**A join is not evidence of a gap.** Both join paths go through `solicitHistoryIfMissing`, the single decision seam, which asks only when this device can point at something missing:

- an existing awaiting marker - written by the replay when it gives up on a frame it can never decrypt (`unreadable-frames`): a PROVEN gap, whatever the local store holds;
- or an empty local store for that group (`no-local-history`): holding nothing, we cannot tell an empty conversation from a missing one. This is also the only case covering a group whose server-side stream has been trimmed, a gap no replay can observe - a frame that is gone never fails to decrypt.

A non-empty store with nothing unreadable in it means nothing is missing: the device stays silent and drops any stale marker. This matters because the commonest join of all is a device ROTATING its MLS identity: the message store and the seen-frame ledger are keyed by USER, not by device, so the rotated identity re-joins every group while the browser still holds every message. Marking on the join event alone put every conversation of such a device into permanent solicitation, with the pending banner over conversations that were already complete.

Markers therefore carry their evidence (`awaitingHistoryRegistry.ts`). One written without a reason is legacy - posted by the old join-time behaviour - and is dropped rather than replayed; a device that IS missing something re-proves it at the next replay.

The **Welcome** join path solicits history the same way (`solicitHistory` in `historySolicit.ts`, called from the joiner's `onWelcomeProcessed` for a genuinely new local conversation). The inviter pushes a bundle on the foreground add path, but its background twin (`send-welcome-and-commit`) does not, so the joiner also asks for it. Solicitation is bounded and receipt-driven: it re-sends on a short backoff (cancelled the moment a `history_bundle` arrives), and the server forwards each call to a RANDOM online member so retries rotate past a backgrounded Android that holds its WebSocket open but cannot process the frame (frozen-online).

The first attempt is deferred by `INITIAL_SOLICIT_DELAY_MS` (~2.5 s) so a self-join peer applies our fan-out external commit before it re-encrypts the bundle - otherwise it would serve the history at its old (pre-commit) epoch, which the joiner (now one epoch ahead) cannot decrypt.

**Request-level timeout / retry (WP-HIST-1 Option C).** `sendHistoryRequest` is online-only: the server returns `no_peer_online` when no responder is reachable, and if the single picked responder is backgrounded or killed the request is silently dropped. To keep the user informed, each `sendHistoryRequest` call is now wrapped in a 30 s response window (`historyRequestPendingStore`).

**Rewritten 2026-08-10** - the store used to own a retry ladder (30 s, 2 min, 5 min, capped at 3) while `historySolicit` owned a second, independent one, so the traffic was their product. The store now tracks ONE attempt per group and **drives none**; asking belongs entirely to `solicitHistory`, on state edges. What is left:

- If a `history_bundle` arrives in the window, the window closes and nothing is shown.
- Otherwise the attempt is over, and the phase says WHY - because the two causes are not the same advice to the user:
  - `pending-unsent` - the request never left the device (`no_peer_online`, or `!navigator.onLine`). Nobody can answer yet.
  - `pending-unanswered` - the request left and the window elapsed. A peer was picked and stayed silent.
  - Before 2026-08-10 both were `pending-offline` and the string named the first, so a silent peer was reported as an empty room. **Two causes under one label is a wrong answer, not a vague one**, and it points at the wrong thing to try.
- `isAttemptOver(phase)` is the one predicate for "this attempt has settled", used by `onResume` and by the UI.
- The pending state is cleared as soon as a bundle arrives (`noteHistoryBundleReceived`).
- The window schedules NO traffic - that is what makes it a legitimate duration. `historyRequestPending.test.ts` pins it with `expect(vi.getTimerCount()).toBe(0)` after a timeout.
- No native or backend changes; the `history-request` wire format is unchanged. Option A (full background FCM wake + headless native runtime) remains planned for a future WP.

**An empty group is ANSWERED, not ignored.** The joiner solicits unconditionally - it cannot tell a group with no history from one whose history it simply cannot decrypt - so a brand-new conversation solicits too. `sendFullHistoryBundle` used to `return` silently when its local store held no message, which made "there is no history" and "nobody answered" the same signal: every join of a fresh conversation ran the full 30 s window into `pending-offline`, showed the offline banner, and kept its durable awaiting-history marker, re-soliciting on every reconnect for the 30 days of the give-up horizon. It now sends a `history_bundle` with `messages: []`, which closes the loop - the receiver calls `noteHistoryBundleReceived` before it even reads `messages`, so an empty bundle clears both the pending window and the durable marker.

That answer is only sent when **our emptiness is authoritative**. The server picks ONE random online member, and a member that just joined has an empty store for a group that may hold years of history held by others - answering "empty" there would wrongly close the requester's loop for good. `isAwaitingHistory(selfUserId, groupId)` (same registry, same 30-day horizon) is the guard: a responder still awaiting the group's own history stays silent, and so does one whose local read THREW, since a failed read proves nothing either. In both cases the requester retries and the server rotates to another member. Silence therefore still means "ask someone else"; only an explicit empty bundle means "there is nothing".

**Cross-session durability.** A solicitation is a one-shot: if the only reachable member is offline when it fires, a naive attempt is lost forever, because a later session finds the group already in WASM and recovery no longer solicits. To fix this, `solicitHistory` records the group in a persistent `awaiting-history` registry (`awaitingHistoryRegistry.ts`, localStorage, per-user, 30-day give-up horizon), cleared only when a `history_bundle` actually arrives (`noteHistoryBundleReceived`). The connection sync (`syncConnectionAfterWsOpen`) calls `reSolicitAwaitingHistory` on every (re)connect, re-driving a fresh solicitation burst for each still-awaiting local group - so the history is retried across sessions until it lands (or the horizon lapses).

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

## How the state is encoded inside the envelope (WP-ANR-1, 2026-08-11)

The envelope above is the SEAL. Inside it, `PersistedState` is CBOR, and how its byte buffers are
framed is a second at-rest format with its own compatibility rule.

**serde has no dedicated `Vec<u8>`.** A derived `Deserialize` routes it through the generic sequence
path, so ciborium wrote every buffer as a **CBOR array of integers** and read it back with one CBOR
header parse *per byte*: `Vec<u8>::deserialize` -> `deserialize_seq` -> `VecVisitor<u8>::visit_seq`
-> `SeqAccess::next_element::<u8>` -> `Decoder::pull` -> `Header::try_from`. Every buffer in the file
was on that path - `identity_bundle`, the whole OpenMLS keystore (`storage_values`), `group_ids`,
and the identity `keypair`/`credential` - and `serde_bytes` appeared nowhere in the repo.

`mls-core/src/byte_compat.rs` fixes it with `serialize_bytes` plus a visitor that accepts a byte
string **or** the legacy sequence. Measured on a 1.59 MB fixture, release build:

| | legacy | byte string |
|---|---|---|
| size | 1 586 917 B | 794 938 B (**x2.00** smaller) |
| decode | 21.6 ms | 0.5 ms (**x45** faster) |

Re-run it with
`cargo test --release --test state_cache -- --ignored --nocapture legacy_decode`. Two honest caveats
on the field figure that motivated this: the 58.6 s of CPU captured in the ANR was a **debug** APK
(debug is ~10x release on the same fixture), and the multiplier that turned a slow read into a
freeze was the per-message reload in the outbox drain, fixed separately - see
[mobile > the drain is a BATCH](../frontend/mobile.md#the-drain-is-a-batch-and-every-part-of-its-shape-is-load-bearing-wp-anr-1-2026-08-11).

**The compatibility contract, and the one-way step.** The reader for the legacy encoding ships in the
same commit, so any existing `mls.bin` or IndexedDB blob loads unchanged and is rewritten in the new
encoding at its next save. The reverse does not hold: **a device that has already migrated cannot be
read by a build older than that commit.** The frontend must not be rolled back past it, or every
migrated user loses their identity and every group. Decision taken deliberately 2026-08-11
(one-step: read both, write new now).

The tests that hold this up, and what each would catch:

- `byte_compat::reads_a_legacy_array_of_integers_file` - the framing.
- `state_cache::a_legacy_encoded_state_still_loads_and_is_migrated_on_save` - a **real** snapshot
  (keypair, credential, keystore, group ids) re-encoded the legacy way, through `load_or_create`.
- Negative control run 2026-08-11: deleting the `visit_seq` arm fails exactly those two plus
  `an_empty_buffer_survives_both_encodings`, and nothing else.

`StateSnapshotCache::from_loaded` was **deleted** as part of this. Seeding the cache with the bytes
just read handed them straight back to the first `save_state`, which would have pinned a
legacy-encoded file in place for ever. A reload now always re-encodes, so the migration happens once
per session rather than depending on what the user does next - which is also why
`a_reloaded_state_re_encodes_and_preserves_its_content` asserts CONTENT equality and not byte
equality (`storage_values` is an unordered `HashMap`; the CBOR is not deterministic).

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
