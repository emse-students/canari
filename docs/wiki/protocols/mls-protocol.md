# MLS protocol

Canari implements end-to-end encryption using **MLS (Messaging Layer Security, RFC 9420)**. All encryption and decryption happens inside a **Rust/OpenMLS** WASM module (browser) or a Tauri native binary (desktop/mobile). The server stores and routes only ciphertext — it never sees plaintext.

**Living docs** (do not archive, actively updated):
- [`mls-desync-prevention.md`](mls-desync-prevention.md) — desync root causes and countermeasures
- [`mls-recovery-ladder.md`](mls-recovery-ladder.md) — step-by-step recovery ladder (rung-1 commit replay → rung-2 external join → welcome_request fallback)

## Key properties

| Property | Value |
|---|---|
| Protocol | MLS RFC 9420 |
| Cipher suite | MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 |
| Forward secrecy | Per epoch (key ratchet on every commit) |
| Post-compromise security | Every device refreshes its own leaf at most every 7 days of activity per conversation ([periodic leaf refresh](#the-periodic-leaf-refresh)); a revoked device's leaf is removed by the stray-leaf collector |
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
| `frontend/src/lib/mls-client/IMlsService.ts` | Interface shared by both |
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
| `apps/chat-delivery-service/src/controllers/` | The MLS HTTP surface, split by concern: `devices`, `groups`, `members`, `messaging`, `invitations`, `locks`, `security`, `push`, `calls`, `internal`, `admin-storage`, `health` |
| `apps/chat-delivery-service/src/app.controller.ts` | What predates the split - still live, no longer the whole surface |
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
| `DeviceGroupMembership` | Per-device state machine (`pending` / `active`), plus the `kickedAt` marker |
| `QueuedMessage` | Pending messages for offline devices |
| `PinVerifier` | Argon2id verifier to detect PIN mismatch across devices |
| `PushToken` | FCM push token per device |
| `RevokedDevice` | Revoked device IDs (triggers resetRequired on next login) |

### DeviceGroupMembership state machine

```
pending --(Welcome queued | commit accepted | activation confirmed)--> active
active  --(kick-stale-device / kick-stale-user)--> pending, kickedAt := now
active  --(detectStaleDevices: no KeyPackage newer than 90 d)--> pending
either  --(device deleted | member removed | group purged | 14 d stale)--> ROW DELETED
```

**THERE IS NO `removed` STATE, AND THE ENUM HAS EXACTLY TWO VALUES** - `'pending' | 'active'`, since
`001_device_group_status_enum.sql` collapsed the retired `welcome_sent` / `welcome_received` /
`stale`. Every removal is a hard `DELETE`: this table carries no `deletedAt` and no soft delete, so
a row that left is ABSENT rather than in a third state. `kickedAt` is not a state either - it is a
marker on a `pending` row answering one question, *is this row waiting on a re-add a kick promised*,
and it is the evidence `reportStrandedDeviceMemberships` partitions on.

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
| POST | `/api/mls/group-info/:groupId` | Holder repair of a stale stored GroupInfo - membership-gated, monotonic write-if-newer. Commits do NOT use it: they carry their base in `POST /api/mls/commit` (see [below](#the-base-travels-inside-every-commit-submission-comm-22)) |

### Device sync / invitation

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/invitations/status` | Report a device's seat `active` or `pending`: promotes or demotes an existing row, never creates one |
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
| POST | `/api/mls/push/key-group-base`, `/api/mls/push/key-group-join` | PushSecret-authed key-group base and external commit: a shut phone joining a salon's key group from the push ([channel-encryption section 26](channel-encryption.md#26-a-shut-phone-joins-a-salons-key-group-from-the-push---decided-by-the-user-2026-10-22)) |
| GET | `/api/mls/history/:groupId` | Redis Stream history (incremental) |

**`sinceEpoch` IS REQUIRED ON BOTH REPLAY ROUTES, AND THEY SHARE ONE POLICY** (`sanitizeEpoch`):
a non-negative integer, or 400. The two disagreed until then - the JWT route refused a negative
while the PushSecret twin clamped it to **zero** and replayed the whole log - and that clamp was a
fallback rather than a kindness: *I could not tell you where I am* is not *I am at epoch 0*, and a
device that cannot read its own epoch has no state to apply those commits to. Every caller already
checks `epoch >= 0` and aborts before asking. A replay from the beginning is still a request any
caller can make, by sending `0`.

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
4. Creator: `addMembersBulk(groupId, devices, excludeDeviceIds)` -> one staged transaction (C7-A): stage the Add, validate the epoch (`POST /api/mls/commit`), merge on accept and broadcast the commit / roll back on reject. Returns `{ welcome, ratchetTree, addedDeviceIds, skipped }` (`skipped` = `{ deviceId, reason }[]`, the reason a typed `SkippedKeyPackageReason` classified in Rust - see [chat-delivery](../services/chat-delivery.md#a-roster-seat-is-not-a-key-and-only-a-welcome-tells-the-two-apart)) (the ratchet tree is exported post-merge).
5. Creator: `sendWelcome(welcome, peerId, groupId, deviceId, ratchetTree)` -> POST `/api/mls/welcome`
6. Creator: `registerMember(groupId, peerId)` + `registerMember(groupId, userId)` - **BEFORE step 5 on every add path**: the server names a joiner before its Welcome can arrive, so an inviter dying between the two leaves nothing half-registered; a user whose registration fails is sent no Welcome (`groupCreation.inviteOrder.test.ts`). **Since ADM-3 the call enrols nobody but the caller, into an empty roster**: the peer was enrolled by the accepted commit of step 4, and the call writes their device rows or answers `409 MEMBER_NOT_ADMITTED` ("The commit is the one writer of a new person")

Only the bulk commit must stay unique (staged under the add-lock). Everything around it is
plain HTTP and runs in parallel (`groupCreation.ts` / `deliverWelcomes` in `groupActions.ts`):
device fetches across invited users, Welcome deliveries across devices (same blob, order-free),
and `registerMember` deduplicated per user. Group invites surface optimistic "pending" member
rows in the group panel while the flow runs (`pendingGroupInvites` in `useConversations`).
7. Peer: Welcome arrives via WS or pending queue -> `processWelcome(bytes, ratchetTree)` -> group joined in WASM
8. Peer: `registerMember(groupId, userId)` + `updateInvitationStatus(..., 'active')`
9. Peer: `saveState(pin)` -> persisted to IndexedDB

**The peer is not the only caller of step 8, and the other one claims less.** If the peer never
reports - added while offline, or its Welcome still queued - the `pending` row outlives the Add, and
every member re-derives "already in tree" on every sync for ever. Since 2026-09-15 a member that
reads the leaf in its OWN tree vouches for it instead of only skipping, which retires the row. A
vouch proves the Add, never a decryption date, so it does NOT replay the pending window - see
[chat-delivery](../services/chat-delivery.md#a-fulfilled-invitation-is-retired-by-whoever-can-prove-it-and-a-vouch-does-not-replay).

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
| `msg_epoch > group_epoch` | Local state is behind | **Rung 1 first**, `attemptCommitReplay`, non-destructive; rung 2 `forgetGroup()` + `requestReAdd()` only on `belowFloor`, a named `gapAt`, or `EPOCH_GAP_ESCALATION_MS` |
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

##### Both halves verified on hardware, and they need two DIFFERENT runs

The trigger and the repair cannot be exercised by one check, because the fix means the trigger no
longer reaches the repair. Both were run on A1 against a browser peer:

| run | what it exercises | result |
| --- | --- | --- |
| `check-loss-a1.mjs` (2026-08-11) | the ORIGINAL trigger: reload the sender, then send | 3/3 delivered before, **6/6 after**, **zero `LOST frame`** |
| `heal-a1.mjs` (2026-08-11) | the REPAIR, on a deliberately rewound sender | 10 `LOST frame … SecretReuseError`, cross-session re-solicit, `HEALED 14/14` |

Zero `LOST frame` in the first run is the point of it, not a gap in it: the sender half persists its
ratchet across a reload, so nothing goes backwards and the receiver never has to detect anything.
The detector and the diff are what the second run covers, and it has to force the rewind to get
there. **A run reporting neither is VOID** - it has shown only that nobody sent anything.

The check carries a positive control for the same reason: it delivers a baseline batch BEFORE the
reload and refuses to report on the trigger unless all of it arrived. Otherwise a delivery that was
already broken would be attributed to the reload.

Worth keeping from building it, because it nearly produced a false FAIL: the first attempt reported
`phone holds 2/3` before the trigger had even fired, and a direct comparison of the two stores
showed all three markers present on both sides. The counter gave up after a fixed number of polls.
**A harness that stops looking early manufactures exactly the silent loss this WP is about**, so the
count is now bounded by a deadline and reports how long it waited - 1472 ms and 1240 ms in the
passing run, i.e. nothing was ever slow; the earlier miss was the harness alone.

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

### Fork detection: a signed epoch fingerprint in every application frame (2026-10-22)

Two members can hold two different trees for one conversation at the SAME epoch number - a fork -
and each side sees only the other's frames refused (`same-epoch-refusal`). To tell the two apart,
every application frame carries, in the MLS `PrivateMessage`'s authenticated data
(set with `group.set_aad`, cleared again on every exit), a signed claim of the sender's view:

- `fp = SHA-256(lp("canari-mls-epoch-fp-v1") lp(epoch_authenticator))[..16]`;
- signed with the sender's credential key over `lp("canari-mls-fork-v1") lp(groupId) be64(epoch)
  lp(fp) lp(identity)`; AAD = `version(1) lp(identity) fp sig`.

**Why the AAD and not the ciphertext.** A member on the other branch of a fork cannot decrypt the
frame at all, so a fingerprint inside the ciphertext would only ever reach members that agree - a
check that can never fire. The AAD is readable before the decrypt, on exactly the arm that fails -
and so by everything that handles the frame's bytes; who that is, and what the `userId:deviceId` in
it adds, is stated in
[history-reconciliation](history-reconciliation.md#restored-history-carries-its-authors-signature-2026-10-22).

**The verdicts** (`mls-core/src/fork_check.rs`), judged on the same-epoch refusal and on success:

| Verdict | Means | Logged |
| --- | --- | --- |
| no claim | an older sender | nothing |
| agrees | same fingerprint, so the frame itself is damaged, not the tree | warn |
| `fork` | a different fingerprint, signed by the sender's key in OUR tree | ERROR, recorded |
| `unproven` | a different fingerprint we cannot attribute | warn, recorded |
| `contradiction` | the frame decrypted at our epoch yet claims another fingerprint | ERROR, recorded |

Findings are bounded (64) and handed over by `take_fork_findings` (WASM) / `prendre_constats_fork`
(Tauri); the client drains them after a same-epoch refusal and reports each through the integrity
finding path ([history-reconciliation](history-reconciliation.md#restored-history-carries-its-authors-signature-2026-10-22)).
The UI comes later.

### A frame from a PAST epoch is two events, and only `content_type` separates them (2026-08-11)

`process_incoming_on_group` compares the frame's epoch to the group's before deciding anything, and
for a frame that is BEHIND it answered `Ok(None)` - "no application payload" - on the reasoning that
such a frame is "almost certainly our own echoed commit". For a **handshake** that is exactly right:
a commit re-delivered after the merge has had its keys consumed by that merge, nothing is lost, and
the caller must ACK it without a word.

For an **application** frame it is a message somebody sent, and it is gone. `Ok(None)` is the same
value a commit echo returns, so both printed the same `[MLS] No application payload … - commit or
dropped frame` line and the entire ladder above was unreachable: no `LOST frame`, no
`unreadable-frames` marker, no history solicitation, and the frame ACKed off the server. Measured on
production 2026-08-11 during a HEAL-W2 run: a restored (rewound) device re-joined the group from a
still-available Welcome, then received a message sent one epoch earlier and dropped it in complete
silence.

The distinction needs no decryption, because **`content_type` is cleartext in the MLS frame header**,
exactly like `epoch` - it is read next to it, before `process_message` consumes the frame. A
handshake keeps its silent `Ok(None)`; an application frame becomes
`Process error: past epoch application frame [msg_epoch=…, group_epoch=…]`, classified as
`DecryptErrorKind::PastEpochApplication` / `'past-epoch-application'` **before** the generic
`Process error:` and `GAP_QUEUED` arms, for the same reason as `TooDistantInTheFuture`: a commit
replay repairs an epoch we are BEHIND and can do nothing for one we are already past.

The policy is `secret-reuse`'s, because the situation is the same one from the other end of the
ratchet - unreadable for good, the group itself healthy: check the frame against
`inboundFrameLedger`, log `LOST frame` when it is genuinely new, mark `unreadable-frames`, solicit
the history diff, ACK. Never a re-add (it would destroy a valid membership to recover nothing), and
never queued for retry on native (no retry can decrypt it).

**Why this is not simply "past epoch = loss".** `max_past_epochs` is 2 on all three group-config
paths, so a message merely overtaken by a commit - ordinary traffic whenever someone is invited
while a message is in flight - still decrypts, and reporting a loss there would manufacture a
phantom gap on every invitation. Reaching this branch means the epoch's secrets are genuinely
absent, which is what a **re-joined** group has for everything sent before its join: a fresh join
starts with no past epochs at all. `tests/past_epoch_frame.rs` pins all three facts - the loss is
reported, the overtaken frame still decrypts, the stale handshake stays silent - and asserts that
the wrapper carries its own marker and no other, since a string holding two markers makes the
classifier's ORDER a decision rather than a fact.

### Our own frame was classified as a retryable gap (2026-08-15)

A device's mailbox holds every frame the group produced, **including the ones it sent itself**, so
every history replay re-offers them and OpenMLS refuses them by design
(`ValidationError(CannotDecryptOwnMessage)`). That refusal is the protocol working - it is exactly
why the sender's optimistic render is its own message's only writer (WP-ECHO-1) - and it was
nonetheless routed through the generic failure arm at all three layers:

| Layer | Before | Consequence |
|---|---|---|
| `mls-core::process_incoming_on_group` | `log::error!("MLS decryption failed: … err={:?}")` | an ERROR on the normal path |
| `mls-core::decrypt_kind` | no arm -> fell through `Process error:` to `SenderRatchetGap` | **native queued the frame in `pending_mls_messages`** and retried it 3x before the sweeper removed it |
| `recevoir_message_bytes` | blanket `log::error!` above the match | a second ERROR, then a `[GAP]` WARN, per own frame |

Only the WEB was quiet, and for the wrong reason: **two shims re-matched the marker in the log text
and rewrote the level** (`mls-wasm`'s `WebLogger`, then `mlsWasmLoader`'s `wasm_bindings_log`), which
is branching on an error message twice over. Their two lists had already drifted apart - one carried
`SecretReuseError`, the other did not - and between them they hid the fact that native had no shim at
all.

**THE TWO LISTS ARE NOW ONE RULE, AND IT KEYS ON THE EMITTER (2026-09-12).** The drift above was a
symptom; branching on another crate's prose was the defect. `mls_core::logging::console_level` reads
`record.target()` - the emitting module path, fixed at compile time - and declines to repeat at ERROR
anything `openmls` narrates about itself. That library logs from inside its framing and validation
code where it knows nothing actionable (`Sender data decryption error` names no group, no epoch and
no frame; `Wrong Epoch: message.epoch() 1 > 10 ...` names no group), and every one of those paths is
wrapped here and reported one line later with the group, both epochs and the marker every consumer
keys on. Production 2026-09-12 held six of the first line in a single idle window, each one shadowing
a proper report of the same frame.

The line is kept at DEBUG, never dropped. `SecretReuseError` stays a separate, text-matched rule
because it names OUR line and a different question - see the module doc. **`mlsWasmLoader`'s copy is
gone**: only the level and the message cross into JS, so that side cannot see who wrote a line and
now prints what Rust decided. **And native, which had no shim at all, takes the same rule** through
`tauri_plugin_log`'s `level_for("openmls", Off)` - the asymmetry that made this defect expensive the
first time. `mls-core/tests/console_levels.rs` pins it; `mls-wasm` has no test in CI, which is why
the decision lives in the crate that does.

**Where it comes from was itself measured, because the harness comment asserting it was wrong on both
counts.** It does not happen on every send: `broadcast_to_group_members` already excludes the
sender's own devices, so no live fanout returns our frame. Opening the DM on two peers **with no send
at all** produced the line once on each, and opening a channel produced none - the source is the
replay, nothing else.

The fix is one arm at the throw, mirroring `TooDistantInTheFuture` and `past epoch application
frame`: `DecryptErrorKind::OwnMessage`, matched **before** the generic `Process error:` rule, logged
at `debug!`, never queued, and the error still surfaced verbatim so
`classifyIncomingDecryptError` answers `'own-message'` and every consumer ACKs. `recevoir_message_bytes`
now picks its severity from the classification instead of from the bare fact that a decrypt returned
`Err` - only an **unclassified** failure keeps `error!`, since that is the one nobody has explained.
`tests/own_message_frame.rs` pins the kind, the marker, and that the same ciphertext still decrypts
for the member it was meant for (without which the classification could be right for the wrong
reason: a malformed frame would pass the first assertion too).

`requestReAdd(groupId)`: tries `externalJoin(groupId)` first (fetch the stored GroupInfo -> build a native external commit -> submit under the epoch gate -> merge, or discard + retry on an epoch race); falls back to a single `welcome_request` when no GroupInfo is available. **A 403 on the GroupInfo read is a membership ANSWER, not a failed attempt**: it arrives typed (`NotAGroupMemberError`) and retires the conversation instead of falling back, which is what makes this seam terminate on a proof rather than on its throttle — see [mls-recovery-ladder](mls-recovery-ladder.md). Self-throttled to one attempt per `RECOVERY_TIMEOUT_MS`; the SYNC_WATCHDOG drives the cadence. No reboot/CAS/successor.

### Our own frame from a PAST epoch was called a loss (2026-10-25)

`CannotDecryptOwnMessage` is only reached at the epoch the frame was sent in. One sent in an epoch
this device has since left is refused FIRST by the epoch check, as `past epoch application frame`
(OpenMLS `TooDistantInThePast`), and the live pipeline read that as a message LOST: a `LOST frame`
line blaming a re-join that never happened, then `Frames are being lost ... reconciling this
conversation` for a healthy group. Reproduced by the campaign's GAP-2 row, which hands a device its
own captured frame three epochs later under a queue id it never saw.

**The envelope already says whose frame it is**, so the question is asked of that fact and never of
MLS's refusal. `isFrameFromThisDevice` (`mls-client/ownDeviceFrame.ts`) is ONE predicate for both
places that meet such a frame: the live handler (`setupMessageHandler`, before the key-group, the
unknown-group and the known-group branches) and the archive replay (`history.ts`, unchanged in
behaviour). It holds when the envelope names this account AND this device's CURRENT id; the frame is
then ACKed with one `[MLS] Own frame for <group8>… delivered back to this device (...) - ACKed, not
offered to MLS; ...` line at WARN and nothing else - no decrypt, no ledger, no loss, no reconcile. It
is a warning because nothing should reach it: the fan-out excludes the sending device (`isSender` in
chat-delivery's `sendMessage`), so a frame here was addressed back to its writer. The line names the
two suspects: a rig injecting it (GAP-2 does, deliberately), or the sender exclusion missing -
`isSender` compares `body.senderId` with the membership `userId` case-sensitively while the send route
accepts a case-insensitive match. That mismatch is UNMEASURED; this line is what would show it.

- **The device decides, not the user**: a frame of this account's OTHER device is decryptable and
  wanted, and still reaches MLS.
- **Only the current id**: an id abandoned at a rotation (`abandonedDevices.ts`) named another MLS
  client, whose frames this state never held - they are handled as a foreign sender's.
- An envelope without `senderDeviceId` is never ours by this test.

Pinned by `setupMessageHandler.ownFrame.test.ts`.

### The base travels inside every commit submission (COMM-22)

Every commit this client makes - external join, staged add, staged remove - submits the GroupInfo
for the epoch it CREATES in the `groupInfo` field of `POST /api/mls/commit`; `validateCommit`
writes it with the epoch advance in ONE transaction, so there is no instant at which the group is at
N+1 and the published base is still N, and no follow-up that a reload or a dropped request can lose.

| Commit | Where the base comes from |
| --- | --- |
| External join | `export_group_info` on the joiner's instance, which is applied at once (at `base + 1`) |
| Staged add / remove | the GroupInfo OpenMLS builds while building the commit: the commit builder makes one whenever the group has `use_ratchet_tree_extension(true)` (every group here) and `add_members` / `remove_members` return it as their third element. `mls-core` serialises it as an `MlsMessageOut` - the wire form `export_group_info` produces - through `add_members_bulk_with_base`, `remove_members_for_users` and `remove_members_for_devices`; `mls-wasm` returns it as the 5th slot of `add_members_bulk` and the 2nd of `remove_members*`; the Tauri commands likewise |

**It describes N+1 while the device is still at N** (the commit is staged, not merged), so it is
never published on its own: only the gate accepting the commit makes it true, and a rejected commit
discards it with the staged commit. `mls-core` errors rather than hand back a commit without a base
(`None` means a group lacking the ratchet-tree extension, a broken invariant that would strand every
stateless joiner). The old fire-and-forget `refreshGroupInfo` after `runCommitTransaction` is
deleted; `republishBaseIfStale` / `base_refresh_request` remain as the holder repair for a base
behind for any other cause (a legacy client's commit, a failed server write). Tests:
`mls-core/tests/external_join.rs` (a stateless device external-joins from the bundle's base at the
new epoch) and `BaseMlsService.refusedCommit.test.ts` (the base rides the submission; nothing is
minted afterwards).

**Server-side membership on an external join.** `validateCommit` promotes the committing device's `DeviceGroupMembership` to `active` (and adds it to the `group:members:<groupId>` Redis set) when it has no active row yet. An external commit is the ONE join path with no Welcome, so nothing else creates that row - and recipient resolution filters on `status='active'`. Without the promotion the rejoined device is invisible to routing while believing it is a member: its own sends work, but it receives neither the history bundle the reconciliation asks for nor any later live message. Idempotent, and skipped for ordinary commits from existing members.

Nothing is replayed to it at that promotion, and nothing is replayed at any other since 2026-09-28: a device joining at the CURRENT epoch cannot decrypt older ciphertexts, the history it actually needs comes re-encrypted through the reconciliation below, and a device a commit ADMITS is queued what it can open at send time ([channel-encryption section 20](channel-encryption.md)).

On a successful external join the device also marks its conversation `active` (external join does not go through the Welcome path that normally promotes it). The pre-join history it cannot decrypt is not asked for here: it comes from the reconciliation that every connection runs, described below.

**History is no longer solicited from the join event, and that whole mechanism is gone.** What stood here until 2026-08-12 - `solicitHistory`, `historySolicit.ts`, the durable `awaiting-history` registry with its 30-day horizon, the `INITIAL_SOLICIT_DELAY_MS` deferral, the retry backoff, the 30 s response window and its "history pending" banner, the vouching that let one member's silence mean "ask someone else" - was measured in production and found unable to terminate: the marker that gated the ask was discharged only by a peer that answered empty AND was not itself awaiting, and both devices of a DM carried one. It is replaced, as a clean break with no compatibility layer, by a **state-key comparison run on every connection**.

The single page for it is **[history-reconciliation](history-reconciliation.md)** - the model, the two boundaries (a shared per-conversation floor and a per-platform device window), the exchange, the scrollback, and every decision behind them. Do not re-derive any of it here. What matters at THIS seam is only the ordering: a join or a reconnect connects, syncs MLS, drains the mailbox to completion (`waitForMessageQueueIdle`, not a delay), and only then compares - because comparing earlier reports a difference the device is in the middle of closing by itself.

**Every bundle names the device it answers.** A `history_bundle` is a group frame, so all members receive an answer meant for one of them. `bundleFrame` (`groupActions.ts`) puts the requester's `digestIdentity` in `to` on every send path - the full store, the id-filtered diff, and the range answer - and the MESSAGES are ingested by everyone (deduped by id, so over-delivery costs bandwidth only). `to` is ADDRESSING, not secrecy - see [durable-rules](../durable-rules.md) on why the `recipients` field of `POST /send` must not be used for it.

**What the bundle carries.** `serializeForBundle` (`groupActions.ts`) sends, per message: `id`, `senderId`, `content`, `timestamp`, plus `reactions`, `isDeleted`, `isEdited`, `editedAt` and `serverTimestamp` when set. Replies need no field of their own - `replyTo` lives inside the serialized envelope, i.e. inside `content`, and travels verbatim. Read state is NOT per message any more: it rides the bundle as the conversation's read watermarks, next to the floor. Pins and system messages are rebuilt by the stream replay when their events are still in the window.

Reception is in two steps, and the order matters. The add-path (`batchAddMessages`) takes only `{senderId, content, messageId, timestamp}` because `AddMessageToChatOptions` cannot carry mutation state; the metadata is merged **afterwards**, onto the messages just added *and* onto any already present (that second half is what makes bundle mutations land on our OWN sent messages, previously skipped as duplicates).

**The unread badge is recomputed, never transported**, and it is derived from the read watermark rather than from any per-message field - see [Read state becomes a watermark](history-reconciliation.md#read-state-becomes-a-watermark).

### A commit that loses a race is rebuilt on proven progress, or surfaced (2026-10-25)

The gate admits ONE commit per epoch. A member's gesture that loses the race is refused
`epoch_mismatch` (the winner landed) or `concurrent_commit` (the winner held the gate's lock) - one race
seen at two instants, read alike by `isCommitRaceRefusal` (`CommitRefusedError.ts`). Every gesture now
ends a lost race the same way (CC-1, CC-2, CC-4 of the 1.4.1 campaign):

- **Rebuilt on proven progress, never on a count or a clock.** `rebuildableRefusal` rebuilds only when
  the refusal's catch-up took the local epoch past the base the refused commit RECORDED, or on an
  overtaken seat claim. `rebuildOnRace` (`utils/chat/commitRace.ts`) is the one loop; the bulk Add of
  an invitation, a 1:1 creation and a group's own devices go through `addDevicesRebuildingOnRace`,
  which reads the tree first and offers only the devices still without a leaf; the pending-invitation
  sweep wraps its single Add; the Remove (`groupActions.ts`, see
  [history-reconciliation](history-reconciliation.md)) and the key-group admission
  (`admitNewcomer.ts`) apply the same rule.
- **A `concurrent_commit` reads the commit log once** (`catchUpOnRefusedCommit`): its `currentEpoch` is
  what the gate read while the winner held the lock, so "not ahead" is not an answer. A winner that
  landed is applied - the progress the rebuild needs; one that did not leaves the epoch, and no gap is
  marked. CC-4 lost an Add here: a leaf refresh accepted at epoch 3, the Add beside it refused with
  `currentEpoch=2`, nothing rebuilt. That read says so in ONE `[COMMIT]` line, never in the replay's
  `[GAP]` narration: an ordinary race is not a gap, and the GAP rows assert the absence of `[GAP]`
  lines. The replay's lines are carried, as detail, only when the log shows the server ahead and the
  group is marked.
- **Every pass re-checks the gesture's premise BEFORE it stages**, because the commit that won may be
  a Remove of the very person being added - and a rebuild must never re-admit someone a removal just
  took out. An abandoned Add throws `AddAbortedError` (`commitRace.ts`), typed by `why`: nothing
  staged, nothing registered, no history served.
  - The sweep (`confirmPendingAddPremise`, `actions.ts`) re-runs `automaticAdmission` on a tree
    confirmed at the server's epoch (`not-a-member-device` when the user holds no leaf there - a
    removed person is a new person again), then re-reads the pending row (`invitation-withdrawn` when
    a removal's record deleted it), in EVERY pass, the first included. The confirmed tree is read
    ONCE PER PASS of a group (`pendingAddFactsOf`: rows judged at one epoch share one commit-log read,
    a rebuild reads afresh); the pending list is read on EVERY attempt, because a removal deletes the
    row before its commit lands - a list kept for the pass would re-admit a device being removed.
  - A member's invitation (`rosterPremise`, `groupCreation.ts`) re-reads the roster before each
    REBUILD: a person on it when the invitation began and off it now (`removed-meanwhile`) was removed
    concurrently - an approved join ask another member declined - and the member is told so. What it
    cannot see: a person absent at the start, added AND removed by other commits between two passes.
  - A read that would show the premise and fails is `premise-unreadable` - the rebuild is not
    justified, and the invitation answers `commit-race-lost` (retry). That sentence is slightly
    inaccurate there: the member reads "the conversation changed at the same moment", while what
    failed is the read that would have shown whether it had. Both lead to the same gesture, a retry.
- **A device is filtered out of an Add only on a tree CONFIRMED CURRENT** (`readConfirmedTree`,
  `utils/chat/confirmedTree.ts` - the helper a Remove's "out" reads too, the whole confirmation under
  the MLS lock like rung 1). A tree behind a Remove still shows the removed device: filtering on it
  skipped an Add that was owed, and when every candidate was filtered the invitation answered `added`
  for people nobody added. A tree holding none of the candidates needs no confirmation (the gate
  decides the commit built on it); one that cannot be confirmed aborts `tree-unconfirmed`, never
  `added`. All three bulk Adds go through it: an invitation, a 1:1 creation, a group's own devices.
- **No progress is surfaced, or kept durable - never dropped.** An invitation is a gesture with no
  durable row (a new person enters only by a member's own Add), so its refusal comes back as a typed
  reason - `commit-race-lost`, `add-lock-busy`, `removed-meanwhile`, `tree-unconfirmed` - and every reason is a sentence the member sees
  (`reportBulkAdditionRefusal`); the member retries. A sweep's pending row is durable: a race without
  progress, or a busy add lock, leaves it `pending` for the next sweep.

Not covered: the welcome_request handler (`actions.ts`, the requester asks again by itself), and a
`concurrent_commit` whose winner has not landed when the log is read - an event-driven wait for the
winner's epoch is the candidate ([backlog](../backlog.md)).

### An invitation whose KEPT commit did not land is re-planned, or the member is told (2026-10-25)

The rebuild above runs inside the gesture. An Add whose answer was LOST is not refused there: it is
KEPT (`commitSubmission.ts`) and the gesture returns. The settlement that later finds it did not land
(`settleUnresolvedLocked`: the resubmission answered `epoch_mismatch`; `settleUnresolvedCommitFromLog`:
another commit holds its base) CLEARED the stage and caught up - and with the stage went the only
copy of the invitation. OFF-3 (1.4.1 campaign, 2 of 2): W1 invited W5 at epoch 2 and was cut, W2
took the group to 5, W1's return logged `refused - cleared`, healed, and W5 never got a seat.

- **The invitation rides in the commit's intent** (`CommitIntent.invitation`: the invited users and
  the ones on the roster when the gesture BEGAN), written by the stage in the same platform call as
  the commit, so it is on disk before the first request. Only a member's invitation carries one: an
  automatic Add is re-derived from its server row, a Remove by the roster collector.
- **The settlement records it BEFORE the clear** (`owedInvitations.ts`, `[INVITE_OWED]` lines), in
  the per-account `localStorage` record, synchronously, under the MLS lock - keyed by group and base
  epoch, so a stage a reload brings back is refused and recorded again under the SAME key.
- **The cause is the gate's TYPED reason, never the shape of its answer.** A business refusal
  (`committer_not_member`, `welcome_target_not_member`, `departed`, ...) comes back in a 200 body
  exactly as the race does, so only `epoch_mismatch` is a `race` (re-planned); every other reason, and
  a 4xx's code, is `refused` and recorded WITH its reason (told, never re-planned).
- **It is re-planned after the lock is let go** (`replanOwedInvitations`, a single-flight drain):
  at once in session, and by a connection's settlement once EVERY kept stage is settled (a drain run
  before would re-plan an invitation whose stage that settlement is about to record again). **Never
  while this device holds an add lock**: the server's lock is not re-entrant, so a re-plan run under
  one would be refused its own and read as "busy" - the drain waits, and the release asks for it.
- **The add lock has a token per acquisition, and a release this device owes is sent before its
  next acquire** (`add-lock.ts` on the server, `addLockMarkers.ts` on the client). The server's lock
  (`SET NX EX`) refuses even its own holder, so a release lost with the connection - or never sent by
  a page that died mid-Add - would refuse the re-plan for the whole TTL. Every acquisition is marked
  DURABLY with its token until a release of it is answered, so a reload is the same case as a live
  page. The marker is claimed synchronously, so two racing acquires never both send it, and no
  release is sent for a group this page holds. The release names its token, so a late one frees
  that acquisition or nothing: never a lock taken since, by this page or by the Android background
  service, which also names its token since this change. A release with no token is the legacy
  owner-only one
  ([legacy-compatibility](../legacy-compatibility.md#no-date-yet---the-add-lock-released-by-owner-alone-with-no-token-2026-10-25)).
- **The owed release says so on the server line.** Two cases print `released=false by=token`: a slow
  Add whose TTL ran out under it, and a revived page's owed release of a lock that already expired.
  Only the client knows which one it is, so the owed release (the one through `claimAddLockMarker`)
  sends `owed: true`. Both doors take it, ignore anything other than a JSON `true`, and append it at
  the END of the line, so the prefix stays the same:
  `[RELEASE_LOCK] group=<g> owner=<u:d> released=<bool> by=<token|owner-legacy> via=<jwt|push> owed=true`.
  Without the flag the line ends at `via=<door>`, as before.
- **A refused acquire carries the server's own fact about when the lock ends** (`retryAfterMs`, its
  `PTTL`). A lost invitation waiting on that group is re-planned at that moment, once per group
  (`wakeAtAddLockExpiry`). This is the one timer, and the server states its value. The client bounds
  that value to 0..31 s (`boundAddLockWait`: TTL + 1 s, since `setTimeout` fires at once above
  2^31-1 ms), reads a non-number as no stated end, and warns when it had to bound one. The wakes go
  with the session (sign-out) and with the client (`destroy`). The holder's
  release sends no frame, and its Add commit lands BEFORE its release (the holder still persists,
  registers and sends Welcomes, 5-8 s), so the commit-applied wake alone would find the lock still up.
- **The re-planner exists only on a RESTORED map** (`makeLostInvitationReplanner`, registered by
  `useConversations` after a restore that succeeded, removed at sign-out). It answers what happens to
  the entry (`ReplanVerdict`): a `pending` conversation, a row not there yet while the group is held,
  a refused add lock or a tree that could not be confirmed (a log unread, a replay held behind
  refused frames, a catch-up short) is `waiting` - the entry stays, and the event that lifts the wait
  drains again (`notifyConversationAvailable`, the external-join re-admission included, a processed
  Welcome, a COMMIT APPLIED in the group - from the frame queue or from a log replay
  (`notifyCommitsApplied`) - the server-stated end of a refused lock, this device's own add lock
  released, the next connection). Which event lifts which wait: a pending conversation, by its
  Welcome or its re-admission; a missing row, by `notifyConversationAvailable`; another device's
  lock, by its stated end (or its commit, as a bound); an unconfirmed tree, by the commits applied
  that confirm it - a log that could not be read with the socket still open is lifted by the
  group's next commit or the next connection, and a catch-up stopped short by the commits it did
  apply, then by the next commit. A `removed` conversation is told as gone; no row and no group (the
  member deleted it) concludes with a log. **A drain runs for ONE re-planner**: a sign-out during it
  stops it, and a re-plan that ends after the session did tells nothing and keeps its entry.
- **The re-plan is the invitation made again** through `processBulkAddition`, under `rosterPremise`
  in its resumed form: the RECORDED baseline (a person on the roster at the gesture and off it now -
  removed, or a join ask declined - is `removed-meanwhile`), a departure after the lost commit's base
  (`removalEpochs`, the case the live premise cannot see), and the first pass checked too. **That
  premise reads the tree's own record, so it runs on the tree CONFIRMED at the server's epoch**
  (`premiseReadsTree`): before the catch-up, the Remove that undoes the invitation may sit in the very
  commits not applied yet, and the Add would undo it. The departures are read AGAIN under the MLS lock
  right before the stage (`addMembersBulk`'s `beforeStage`), so a Remove applied between the
  confirmation and the stage is never staged over. A person already holding a leaf is not added
  twice (`already-in-tree`). The new commit carries the ORIGINAL baseline, so a second loss is judged
  against the gesture's own start.
- **A record that cannot be written** (no storage, a full quota) never leaves the refused stage in
  place - that would block every commit of the group: the stage is cleared, the loss logged at error
  with its reason, and the member told. A page with no storage says so once.
- **Idempotent from durable state, not a clock.** The entry leaves only once the re-plan CONCLUDED.
  A reload in between re-plans it once more, and the confirmed tree answers `already-in-tree` if its
  Add had merged; a re-plan whose own Add is kept hands the invitation to THAT stage's intent.
- **The member is told every ending that is not a seat.** The gesture whose Add got no answer now
  answers `outcome-unknown` ("will be finished once the connection is back"), not `failed`; one that
  staged nothing behind an EARLIER unanswered commit (`PreviousCommitUnresolvedError`) answers
  `previous-commit-unresolved`. A re-plan that does not complete is a toast naming the conversation
  (`reportLostInvitation`); only an ending a new invitation could lift says "invite them again" - a
  gate refusal and a retired conversation have their own sentences.

Not covered, in [backlog](../backlog.md): a 1:1 creation and a group's own devices carry no
invitation; a kept commit is settled only by a connection, while the toast promises "once it is
back"; and a re-plan that dies between its merge and its Welcomes finds `already-in-tree` next
time and sends none.

### Group reset - THERE IS NONE, AND EVERY PIECE THIS SECTION DESCRIBED IS GONE

> Every state and transition on this page is drawn, with its `file:line`, on
> [`mls-graine-state-machine.md`](mls-graine-state-machine.md).

This section documented `mlsService.sendGroupReset(groupId)` reaching
POST `/api/mls/groups/:id/reset`, a server resetting every `DeviceGroupMembership` to `pending` and
the epoch to 0, and a `group_reset` broadcast. **Not one of those exists**, verified 2026-09-12 -
and a page promising a repair that was deleted is worse than a page saying there is none, because it
makes a reader plan around it.

- No `sendGroupReset` in the client, and no `reset` route on any group in the delivery service. The
  only `@Post` matching `reset` in the whole service is `mls/security/pin-reset`.
- `dm_groups.activeEpoch` has exactly ONE writer, `validateCommit`, and it only ever writes
  `baseEpoch + 1`. **Nothing in this system can return a group to epoch 0.**
- `group_reset` survives only as an INBOUND control frame, which the client acknowledges and
  ignores.
- The native `bootstrap_dead_conversation` command POSTed to `claim-bootstrap` then `reset-epoch`,
  both deleted, and had no caller of its own. **It is deleted too** (2026-09-12): it was the last
  thing in the product claiming a group with no holder could be rebuilt.

**A group whose tree no member holds any longer cannot be reopened, and that is a property of MLS
rather than a gap here.** Every way into a group in RFC 9420 - Welcome, external commit, ReInit,
subgroup branching, external proposals - requires a party holding the group secrets, and this server
holds only ciphertext. A server-side resurrection would be a backdoor, which is why the spec has
none. The recovery ladder's dead ends are enumerated in
[`mls-recovery-ladder.md`](mls-recovery-ladder.md).

### Reconnect after network loss

1. `scheduleReconnect()` -> exponential backoff (1s, 2s, 4s, 8s, 16s, 30s), **saturating at 30s and
   never giving up**: only being logged out or a `SessionExpiredError` (401/403) ends the loop, since
   a transport failure is not an answer. See
   [auth](../frontend/modules/auth.md#wp-reconnect-1---the-ladder-that-stopped-and-the-two-silences-under-it)
   for the 20-attempt latch this replaced and why it stranded desktop tabs for ever.
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

## Device binding

**A KeyPackage is checked against the device it was fetched for, and device keys are pinned on first
sight.** The decision is Rust's (`frontend/mls-core/src/device_trust.rs`); the TypeScript face is
`frontend/src/lib/mls-client/deviceTrust.ts`. Tests: `frontend/mls-core/tests/device_binding.rs`,
`deviceTrust.test.ts`, `BaseMlsService.deviceTrust.test.ts`, `actions.welcomeRequest.test.ts`,
`actions.pendingInvitations.test.ts`, `refusedDevices.test.ts`.

- **Binding.** Every Add carries, beside each package, the `userId:deviceId` it was fetched for
  (`add_members_bulk_with_base(.., expected_identities)`). A credential naming anything else is
  skipped as `identity-mismatch`. The user half compares case-insensitively, the device half
  exactly, and an identity holds exactly one `:` - the TypeScript parsers (`leafIdentity.ts`) read
  an identity with more as naming nobody. Pin lookup and binding use ONE canonical identity
  (`canonical_identity`: user half lowercased, device half as is): the pin store is keyed by it,
  every lookup and comparison goes through it - the tree-key lookup a seed endorsement is checked
  against (`member_signature_key`), the removals by user and by device, the batch dedupe, and the
  native push checks (`canonical_user_of`, `canonical_user_id`). `canonical_user_of` also reads the
  LEGACY BARE `userId` credential as its user with no device; it is never pinned and never matches a
  device ([legacy-compatibility](../legacy-compatibility.md)). A persisted record NOT keyed
  canonically is dropped with an ERROR at load, never merged into a pin: merging would turn a key
  conflict between two records into trust. Its TypeScript twin is `leafIdentity.ts` (`canonicalIdentity`,
  `canonicalUserId`, `sameDeviceIdentity`, `treeHoldsDevice`), tested on the same cases. It is used
  by every TypeScript tree check and every comparison against a leaf's user half, so a spelling Rust
  takes for a device never reads as absent and falls through to an Add.
- **Pins.** Each identity maps to the SET of signature keys this device has seen for it, kept in the
  sealed MLS state (`PersistedState.device_pins`, CBOR, `#[serde(default)]`). A state written before
  pins existed is seeded at load from every tree it holds, so nothing already trusted is refused. A
  package for a known device under an unknown key is skipped as `signature-key-changed`. Nothing
  today can prove such a change - the old key goes with the lost state and there is no
  cross-signing - so the refusal stands until the device re-enrols under a new id, or a merged tree
  shows it still holding its pinned key (below).
- **Bounded.** Past 8192 pinned identities (`MAX_PINNED_IDENTITIES`), the pins of identities no held
  tree contains are dropped, AT LOAD ONLY (`prune_absent`) - never when a group is forgotten, since a
  forget is half of a forget-and-re-Welcome heal and the pins it would drop are about to be needed.
  A pin of a device still in a held tree is never dropped. A dropped identity is remembered
  (`device_pins_pruned`, bounded at 8192), and a pin written for it again is UNANCHORED: learned
  from a tree after this device had already forgotten it, so it vouches for less than a pin held
  since first sight. A prune is reported at WARN (`PINS PRUNED`, with the counts), and every load's
  `state composition` line carries `pins <n>, <m> pruned remembered`. Both go to the device log
  only - pins are client state the server never sees.
- **A group the load does not seed.** A group with a staged commit at load is not seeded (its tree
  may be an external join's server-served one). It is seeded from the tree the first merged commit
  was built on - ours accepted, or a member's - or, if its commit is refused, from the tree it falls
  back to at that moment.
- **Reaffirmations.** A pin counts the merged commits that showed its device holding the pinned key -
  its leaf re-entering under that key, or a commit it signed. A merge with nothing pending signed
  nothing and counts nothing (`a_merge_with_nothing_pending_reaffirms_no_pin`). This is what lifts
  a remembered refusal (below).
- **The replace path: ONE commit.** `handleWelcomeRequest`, for a device whose leaf is still in the
  tree, sends Remove and Add in the SAME commit (`replaceMember` -> Rust
  `MlsManager::replace_device_with_base`, WASM `replace_device`, Tauri `remplacer_appareil`); the
  Welcome goes to the re-added device. It used to kick the leaf, then re-add it in a second commit,
  which left the device out of the group in between and recorded a departure for a device that never
  left. The package is vetted FIRST, in TypeScript and again in Rust: a refused package stages
  nothing. Its signature key must also EQUAL the key of every leaf it removes - local signed
  evidence that holds with or without a pin. `addMember` and `replaceMember` throw the typed `DeviceTrustRefusedError` before staging,
  and the callers log it once per identity per session (`reportDeviceTrustRefusal`) and retire
  nothing. No path kicks any more: an Add refused as a `DuplicateSignature` asks the tree WHOSE
  leaf carries the package's key (`leafHoldingKeyOf`, Rust `leaf_holding_key_of`) - the tree merely
  containing the identity does not make the duplicate its leaf. If the holder is this identity, a
  welcome request replaces it in one commit, and a pending invitation is already fulfilled (vouched,
  no commit). If another identity holds it, which no legitimate flow produces (a device that changes
  id starts with a fresh key), nothing is vouched, replaced or removed, and the line is an ERROR of
  its own (`DUPLICATE KEY HELD BY ANOTHER DEVICE`). A holder that cannot be read, or a key no leaf
  carries any more, is a WARN and the next request decides.
- **A refusal no retry can lift is remembered.** Every package of a device carries the same
  signature key, so a `signature-key-changed` refusal would come back at every sweep, each one
  spending a one-time KeyPackage. It is recorded per own device (`refusedDevices.ts`,
  `ACCOUNT_KEY.refusedDevices`), and `processPendingInvitations` and `handleWelcomeRequest` skip that
  device without fetching anything, with a line naming the remedy: its owner resets it, and it
  re-enrols under a new id. An `identity-mismatch` is not remembered - the next package may be the
  right one. Each entry stores the pin's reaffirmation count when it was refused, and is LIFTED when
  the count has grown (a merged tree showed the device under its pinned key, so the refused package
  was not the device's) or when the pin is gone. Nothing is remembered for a device with no pin. A
  device that rotates its own id drops what its old id remembered (`forgetRefusedDevicesOf`). The
  bulk-Add skip report (`warnSkippedKeyPackages`) says each refused device once per session.
- **External commits.** Pins gate the Adds this device builds. An external commit is a joiner
  adding itself under its own signature, which another member cannot refuse without forking, so it
  is merged as signed and what it admitted is recorded like any other admission. The joiner pins the
  tree it joined only once its commit is MERGED (`pending_external_joins`): a join the server refused
  pins nothing. The marker is in the sealed state, so a checkpoint and a restart before the merge
  keep it, and the load-time seeding skips any group with a pending commit. Clearing an external
  join's pending commit forgets the group: there is no prior epoch to fall back to.
- **Events.** Every NEW device a merged commit admitted - ours or a peer's, the signer read from the
  verified commit - is recorded as a `DeviceEvent` (`identity`, `keyFingerprint`, `trust`:
  `first-sight` / `key-changed`, `addedBy`). The diff is on `(identity, key)` pairs, never on leaf
  indexes, and a device re-added under its pinned key records nothing - a heal or a resync re-adds
  devices daily, and an event each time would announce the same device again. The list is bounded
  (512, the oldest dropped, said once per filling) and lives in the sealed state until
  `IMlsService.takeDeviceEvents()` takes it. It is recorded whatever kind of group admitted the
  device: the kind decides where a notice is PLACED (`deviceEventAudience`), not what is recorded. A
  commit another member made is applied as signed - refusing it would fork the group - and what it
  admitted is recorded.

- **A key this device has seen: `pinnedSignatureKeys(userId, deviceId)`.** THE one source for any
  verifier of a signature made by a device key (an admission voucher, a signed history entry): the
  pins, never a key the server published alone. It answers a `DevicePin` -
  `{ keys: Uint8Array[]; anchored: boolean; reaffirmations: number }` - or `null`. `null` is a device
  never seen, or one whose pin was pruned past the bound - a verifier reads it as UNVERIFIED, never
  as FORGED. `anchored: false` is a pin re-learned after a prune: a signature verifying under it is
  weaker evidence, and a verifier says so rather than calling it verified. Several keys come back
  only for a state seeded from trees that disagreed; a signature verifying under any of them was
  made by a key this device saw. The "no pin" line is logged once, in Rust. Rust
  `MlsManager::pinned_signature_keys`, WASM `pinned_signature_keys`, Tauri
  `cles_signature_epinglees`.
- **Departures: `removalEpochs(groupId, userId)`.** When a merged commit - live, replayed on
  catch-up, or our own - removes a USER's last leaf from a tree, `(groupId, user, epoch)` is recorded
  in the sealed state (`PersistedState.device_departures`, bounded at 8192 like the pins: past it,
  the departures of groups no longer held are dropped). Recorded at merge time, so a device that
  only caught up on a kick and a re-add still sees the removal. Compared per user over the trees: a
  one-commit leaf swap (an external rejoin, a heal, the one-commit replace above) and one device
  among several leaving record nothing; a kick and a re-add in two commits is a departure whatever
  the kick was for. Two properties a reader must hold: it is PER USER, not per device, and it holds
  only the commits THIS device merged - a commit before it joined, or one it skipped through a
  Welcome, is absent. Never a device event and never shown. An empty answer is NOT SEEN, never
  "never happened". Rust
  `MlsManager::removal_epochs`, Tauri `epoques_departs`.

### What each legitimate flow does

| Flow | Outcome |
|---|---|
| Last-resort or one-time package rotation | Same device signature key, so the pin matches: no change. |
| PIN change | Re-seals the state, the signature key is unchanged: no change. |
| Several devices on one account | Each `userId:deviceId` has its own pin. |
| Web device ids (`web-<user>-...`) | Ordinary identities, pinned like any other. |
| Reinstall or factory wipe (new id) | A new device: first sight, admitted. |
| Restore (WP-RESTORE-1) | Enrols as a new device, first sight. |
| A device that kept its id but lost its state | **It is a new device** (decided 2026-10-22): at start-up it rotates to a new id (`reenrolLostState`) and its owner's devices see a new device. Taken only when the id pre-existed this boot AND the store PROVES the state absent - no `mls.bin` or an empty one (`mls_state_absent`), no IndexedDB record - never on a decryption failure, a PIN problem or a read the store could not answer. The old id is recorded (`abandonedDevices.ts`) before its deletion is asked and leaves the record only once the server confirms it, so it is retired exactly once; the live id is never deleted. A device that did a same-id fresh start on an older build is refused re-adds by upgraded peers (remembered, so no package of it is fetched again) until it resets; meanwhile it can still re-enter a group by external commit, which pins do not gate. |
| Downgrade to a build without pins, then upgrade | The older build drops the pins it cannot read; the upgrade re-seeds them from the trees. |
| A Tauri resume reload | Events not yet persisted in `mls.bin` can be lost with the reload, as any unsaved state is. |

### New-device notices (decided by the user 2026-10-22, refined the same day)

No mandatory approval of a new device. Instead, **produced by the client from the signed commit it
processed, never from a server message** (a server that stays silent must not silence them):

- the account owner gets an alert "a new device was added to your account", in the app and as a
  local notification on the phone, whichever group the commit came from;
- contacts see a discreet line "X added a device" in **private conversations only** (1:1 and
  groups), **never in a community or salon key group**, where it would be noise.

**What counts as a new device** is decided where the event is recorded, as a fact
(`DeviceEvent.memberAlreadyPresent`: the user already had a leaf before the commit) and one predicate,
`announcesNewDevice()` / `DeviceEvent::announces_new_device`:

| Event | Announced? |
|---|---|
| first sight, the user was already in the conversation | yes |
| first sight, the user arrives with it (a new member, a new conversation) | no - that is the member-added line |
| a resync, a heal, a kick and re-add under the pinned key | no - not even recorded (`pinned` is refused by the predicate as well) |
| `key-changed` admitted by a commit | yes, wherever it is - nothing proves it |
| `key-changed` found in a joined tree (`addedBy` null) | no - no commit admitted it |
| the processing device itself | never |
| an event recorded before `memberAlreadyPresent` existed | no |

Then `deviceEventAudience()` (`deviceTrust.ts`) routes it: `owner-alert` for this account, from
any group; `contact-line` for a contact, asked once PER CONVERSATION the line could go in, so a
community or salon key group never gets it; `none` otherwise. Rust's
`DeviceEvent::is_owner_alert` applies the owner half for the background engines, and both are held
to ONE table, `frontend/mls-core/tests/fixtures/device_notices.json`, read by a Rust and a TypeScript
test. One device under one key is announced once (`deviceEventKey()` = `notice_key()`).

**First sight by THIS device is not "new to its owner"** (#2278 review): a fresh install, a restore,
a pin dropped by the bound, or a heal re-adding a device that was never in a tree this device holds
all show OLD devices for the first time - and heals happen daily. So the app weighs one more piece
of evidence, `isNewToItsOwner()` (`deviceTrust.ts`): the server's first sight of the device's key
(`DeviceSignatureKey.firstSeenAt`, served as `firstSeen` by `GET /api/mls/devices/:u/:d/signature-keys`).
It is used ONLY TO SUPPRESS, never to raise - the signed commit stays the only source of a notice,
and the device list stays the place to audit the account:

| Key first seen by the server | Owner alert | Contact line |
|---|---|---|
| never dated (published before the key history began) | no | no |
| before THIS device enrolled (first sight of its own key) | no | no |
| since this device enrolled | yes, however late this device learns of it | only within 7 days (`CONTACT_NEW_DEVICE_WINDOW_MS`) of learning of it |

Chosen over a per-contact baseline of pins, which cannot tell a contact's old laptop a heal brings
into a DM from a new one; the window trades a late line for no false one (the user: notices must not
become noise). An age the server did not answer keeps the event for the next delivery
(`undecided`, durable, 64 at most) - neither raised without evidence nor lost for want of it. The
app finds the key by fingerprint (`keyFingerprintOf()`, Rust's `key_fingerprint`, held to
`mls-core/tests/fixtures/key_fingerprints.json`).

**Who consumes the events.** `BaseMlsService.setDeviceEventConsumer` hands the taken events to
`deliverDeviceEvents` (`utils/chat/deviceNotices.svelte.ts`, registered by `registerDeviceNotices`
at session start): after every drain, after this device's own Adds (`addMember`,
`addMembersBulk`, `replaceMember`), and once at registration for what the sealed state already
holds - so the 512-event store drains. An EMPTY take is handed over too: it is the durable moment
the notices retry what they parked (an `undecided` event, an owed line), so a quiet account does not
leave an alert parked until some unrelated device event arrives. With no consumer they stay:
sign-out removes it (`unregisterDeviceNotices`), so the events wait in the state for the account
that consumes them next.

- **The contact line** is a client-written system row (`chat_system_device_added`), message id
  `device-added:<groupId>:<key>` - one per conversation, idempotent, not unread, no sound, like every
  `system` row. It is written in EVERY 1:1 and group row whose tree (`getGroupMemberIdentities`,
  read locally) holds a leaf of the device's owner, whichever group admitted the device - a
  contact's new device is often first seen in a community they share, and the line still reaches
  the private conversations. Never in a channel row or a key group. Written once per device and
  key, durably (`lined`, the last 256), not only against the messages a conversation has loaded.
  A device is LINED only once no line is still owed: a group this device holds
  (`getLocalGroups`) with the contact in its tree but no row loaded yet - the start-up drain may
  run before the rows load - or whose tree is unreadable keeps the line OWED (`owedLines`, durable,
  64 at most, an overflow warned with its count), retried at each hand-over without asking the
  evidence again, and dropped past the 7-day contact window (the drop is persisted too). A held
  group with no row loaded is owed only if the DURABLE store holds a live row for it
  (`IStorage.getConversation`, lifecycle not `removed`): a key group never has one, and the
  session-local `isDistributionGroup` may not name it yet at start-up; a deleted conversation's
  lingering state has lost its row.
- **A reset device re-added in one commit** (`replaceMember`) under a key a member never saw for it
  reads to that member as "added a device": it is a device under a key they never saw, which is
  what the line says. Defensible, and deliberate - the line never claims the device id is new. A
  repair under the PINNED key announces nothing (`pinned`).
- **The owner alert in the app** is `NewDeviceBanner.svelte` in the layout's banner column: the
  device's name when the device list has one, when this device learned of it, and a link to
  `/settings/security`. Durable per account (`ACCOUNT_KEY.deviceNotices`: the unseen alerts and the
  last 256 announced keys) until dismissed or followed.
- **A refused device of the owner's own** (`refusedDevices.ts`, a changed key under a kept id) is
  told in the same banner column, with the remedy (`device_refused_remedy`: remove it from the
  devices, sign in on it again, and it enrols as a new device). Built from the refusals this device
  remembers at registration and from each new one (`setRefusedDeviceListener`); dismissed once, it
  does not come back (`refusedSeen`). A contact's refused device is not told to anyone: its owner
  learns of it only from a device of their own that refuses it too.
- **The local notification** is raised by the native background engines only, from a commit they
  merged in memory: the Android FCM service (a commit push, a catch-up, or its own background Add of
  the account's new device once the server accepted it) and the iOS notification extension (a
  catch-up before a message - the extension never sees a silent commit push, so an iPhone whose app
  is closed learns of the device at the next message push or when the app opens). Each push-decrypt
  answer carries `ownDeviceAdded` (`mobile/device_notice.rs`); the keys are claimed in a ledger of
  one marker file per key (`create_new`, atomic across the app and the extension), in the app data
  directory on Android and the App Group on iOS. The app claims the keys it showed
  (`claim_device_notices`), so a later push replaying the commit notifies nothing. In the
  foreground neither engine posts: Android reads `MainActivity.isInForeground`, the iOS extension
  the `app_in_foreground` file the app keeps in the App Group (`CanariSetAppGroupForegroundFlag`).
  The engines have no key ages, so at registration the app PRE-CLAIMS every key of the account's
  other listed devices that `isNewToItsOwner` calls old - an old device a heal brings back is then
  never posted. The ledger is swept with the account's push files on deletion.
- **A background Add the server refused** (Android `processWelcomeRequestBackground`) admitted
  nobody, and announces nothing. Its events exist only in the STAGED post-add state
  (`prepare_welcome_background_with_key`), which is installed into `mls.bin` only on the server's
  acceptance and discarded otherwise, so a refusal leaves the app no event to read. The service
  posts the notification on `Outcome.Accepted` alone: the server admitted the device, whether or
  not this phone could install its own copy.

**Known limits, owed a decision or a reading:** a phone whose WebView is alive in the background
processes the commit itself and so shows the in-app alert only, with no local notification; and a
device first seen inside a tree this device JOINED (its leaf pinned silently) is never announced.
The pre-claim reads the device list, which omits devices idle for 30 days, so a background engine
can still post for such a device when a heal brings it back; the app does not announce it. A
contact's new device this device learns of more than 7 days late gets no line. Keys recorded when
the history began carry that date, not their device's enrolment.

### Who admits a new person (2026-10-23)

**A new person enters a conversation by a member's own gesture, never by an automatic Add.** The
two automatic adders - the pending-invitation sweep (`processPendingInvitations`) and the
`welcome_request` handler, plus the Android background answer (`prepare_welcome_background_with_key`)
- act on what the delivery service says: a `pending` row, a roster row, a relayed request. None of
that is a member's decision. So before either builds an Add, it reads THIS device's tree: a requester
whose USER already holds a leaf is a member's new or recovering device, and is added as before; a
user who holds none is a new person, and is not added (`automaticAdmission` in `actions.ts`,
`MlsManager::user_holds_leaf` in Rust, `treeHoldsUser` in TypeScript). A tree that cannot be read
proves no membership, so nothing is added (it used to fall through to the Add).

Instead, the ask is put to a member: **"X asks to join this group. Only a member can add them."** (`join_request_body`), with Add and Decline
(`JoinRequestBanner` for the conversations not on screen, and `JoinRequestRow` - a card at the end of
the thread - for the one that is, user decision 2026-10-24: in the conversation, any member may
accept; `joinRequests.svelte.ts`). The card FOLLOWS the store and is not a persisted system row: a
stored row would outlive the ask and keep Add and Decline on screen for someone another member
already admitted. Both answer through one path (`answerJoinRequestOrToast`). Add is the member's own Add (`inviteMembersToGroup`,
signed by their device); Decline withdraws the ask (`declineJoinRequest`, below), which is what
stops it coming back. The sweep reads the server's `pending` rows, the durable state, so each
completed sweep replaces the asks on screen.

**Every online member sees the ask at once, and sees it go at once (2026-10-25).** A
`welcome_request` reaches ONE elected device, so every other member used to learn of an ask only at
their next sweep, minutes later. Now chat-delivery announces it itself: `acceptGroupInvite` sends
`group.join_ask` (`groupId`, `askId`, `requesterUserId`, `requesterDeviceIds`) to every online device
of every ADMITTED member except the asker, and the outcome goes out the same way as
`group.join_ask.settled` (`askId`, `outcome: 'admitted' | 'declined' | 'expired' | 'withdrawn'`) -
after the transaction that lifted `awaitingAdmission` (either door) commits, after a Decline or a
removal by another member (`declined`), after the asker removes their own awaiting seat
(`withdrawn`), and after `expireUnansweredAsks` deletes it (`expired`); only for a seat that call
really changed, so a second Add or a late Decline announces nothing (`utils/join-ask-announce.ts`).
The announcement never runs inside the commit lock and never delays the HTTP answer: it is dispatched
after the lock is released, one Redis script per device checking presence and capability and
publishing together.

**An ask has an IDENTITY, `askId` - the id of the seat its link wrote** (`dm_group_members.id`). A
Decline deletes the seat and a new ask writes a new one, so a person's second ask is a second
identity. It is carried on both frames, on the pending sweep rows and on the roster rows while the
seat awaits. The client settles BY IDENTITY and remembers every settled one for the session
(`settledAsks`, `joinRequests.svelte.ts`): any read made before a settlement - a sweep, a roster read,
an announcement - is not raised however late it lands, a settlement of an older identity leaves the
person's newer ask on screen, and an Add or Decline tapped on an ask already settled runs nothing
(an answer the server settled WHILE it ran reports nothing left, not a failure). No order of arrival
is assumed; the earlier `joinRequestClock` (a count of settlements) assumed one and is gone. The
other direction holds the same way: a completed sweep removes only asks that were ON SCREEN WHEN IT
STARTED (`beginJoinRequestSweep`, by identity), so an ask announced while it was reading - which its
rows may predate - is not wiped by its silence. The same snapshot orders two asks of one person: an
ask on screen before the sweep is older than its rows, so the sweep's different ask replaces it; an
ask that arrived while it read stays, and the sweep's (older) read is not raised over it
(`settleSweptJoinRequests`; the snapshot is taken in `processDeviceInvitationsLocally` before the
read, pinned by `joinRequestSweepOrder.test.ts`).

**Only a client that routes these frames receives them.** A build older than them would log every
one as reaching no handler, so the socket declares `join-ask-1` (`caps=addressed-history-1,join-ask-1`,
`gatewaySocketUrl`), chat-delivery publishes to a device only when every live session declared it,
and the gateway keeps a frame naming `requiresCapability` from any session that did not
([chat-gateway](../services/chat-gateway.md#presence), [legacy-compatibility](../legacy-compatibility.md)). The client raises the announced ask through the same gates as the
sweep (`raiseAnnouncedJoinAsk`: a group, the member's own tree read, `automaticAdmission`), and it is
the same entry, keyed `(group, person)`, so the sweep and the elected device's `welcome_request` do
not duplicate it. The election stays for the mechanical answer to a member's own new device. A
settlement removes the ask on every screen, so the member who lost an Add/Decline race sees the
winner's outcome without a refresh.

**The joiner's own row says what it is.** A joiner whose ask is unanswered holds a `pending` row for a
conversation it was never in, which used to read "Canal E2E établi.". The server's groups list carries,
for this device's seat, `deviceMembership.awaitingAdmission`; discovery stores it on the row
(`Conversation.awaitingAdmission`, IndexedDB and SQLite schema v15, `syncAdmissionFlags`), and a
`pending` row that carries it (`isNeverAdmitted`, `admissionState.ts`) reads "En attente qu'un membre
vous ajoute." (`chat_awaiting_admission_preview`). When the list stops naming such a row - declined,
or expired - discovery removes it with no status read: there is no past and no exclusion to keep.
Only on a list that may be believed (`absenceIsEvidence`); a row that was ever `active` is not
never-admitted, and both demotions out of `active` clear the flag.

**A declined ask ends the joiner's recovery too, read and never learnt by failing (ADM-2,
2026-10-25).** While it waits, the joiner's `requestReAdd` marks the group not-ready, and that marker -
persisted, enumerated by the SYNC_WATCHDOG - is what drives every later pass. Discovery removed the
declined row and left the marker, so the next pass (after a reload, 27 s later) found no row for its
device - the decline deletes the seat and its device rows - read that as an `active` row would read
(`not-pending`: "joined once, serve yourself"), re-created the placeholder, tried an external join the
server refused with a 403, and retired the placeholder as a `removed` conversation the user then saw
listed. The changes that close it:

- `purgeLocalConversationRecord` drops the not-ready marker with the row, at every site that drops
  one, so no pass is scheduled for a conversation that is gone (and logs a stored row it could not
  delete). The in-memory cooldown is a throttle and stays.
- `requestReAdd` reads "no row for this device" as its own answer and asks the account's seat on the
  groups list (`readAccountSeat`, under the `absenceIsEvidence` guard). A list that cannot be
  believed skips the round. A seated account keeps its door, re-read from the list's own
  `deviceMembership` when it carries one. No seat ends the recovery - no row created, no join, no
  ask - but only for what the list can speak for: no conversation row, or a never-admitted one. A
  row this device was ever in is decided on the group's roster by ONE reader and ONE reducer that
  discovery now shares (`readStillUserMember`, `decideAbsentGroupFate` in `groupLifecycle.ts`): the
  typed 403 `NOT_A_MEMBER` is a proven exclusion and retires the row, `active` or `pending` alike - a
  `pending` row kept on it re-ran recovery on every sweep; a roster that does not answer skips the
  round; a roster that names us means the list was stale, and the pass goes on to the join.
  Discovery used to swallow that 403 as doubt (`.catch(() => null)`), so its exclusion branch never
  fired.
- `stopRecovering` removes a never-admitted row instead of retiring it - the decision discovery takes
  for the same row.
- **The `absenceIsEvidence` guard had a blind spot, now closed (review of #2493).** It refused an
  empty list whenever the device held trees, and the list never names Graine key groups - so for any
  community member an honestly empty list (a joiner whose only ask was declined) was unbelievable for
  ever, and neither recovery nor discovery could end the ask. It now counts conversation trees only
  (`isDistributionGroup` excluded, `groupSweep.ts`). The price is taken deliberately: a member whose
  only conversations are pending link asks now believes a transient `200 []` too, and its ask row is
  removed locally though the seat stands - a second ask from the link, and no history lost, since a
  never-admitted row holds none.

Nothing local records the decline: the server's missing seat is the terminal state, read afresh on
every pass, so a member who Adds the person later is not blocked - the Welcome installs the group and
writes the row.

The user chose this (2026-10-23) for the group invitation link (`/g/join/<token>`), which used to
admit the person with no member involved. The Android background answer refuses such a request as
`newcomer` and leaves it to the foreground's sweep. Only a GROUP conversation takes an ask
(`askAMemberToAdmit`): a 1:1 conversation's `pending` rows and a key group's requests raise nothing -
a DM ask's Add always failed and its Decline deleted the peer's own roster row. And only a seat the
server holds AS an ask is asked about: the pending rows (`GET mls/invitations/pending`) and the roster
read (`GET .../user-members`) carry `awaitingAdmission`, and a person absent from the tree whose seat
is not flagged - a member's invite between its roster write and its Add, a seat written before
migration 038, a member whose leaves were removed - is neither added nor asked about (logged "not an
invitation-link ask"). A member's own invite brings such a person in. The banner shows an ask only
while the chat page that answers it is mounted (`canAnswerJoinRequests`).

**An answer leaves the screen only when it happened** (`joinAnswers.ts`). The invite never throws; it
returns a typed `BulkAdditionOutcome` (`added` with the users the merged commit put in the tree, or
`not-added` with `add-lock-busy`, `no-device-added`, `failed`...), and Add is done only when the
person is among `addedUsers` - or already holds a leaf, another member's Add having come first. Decline
is `POST mls/groups/:groupId/join-requests/:userId/decline`, answered only to an ADMITTED member
other than the asker (`403 NOT_A_MEMBER` otherwise). Under the seat lock it deletes the seat ONLY
while `awaitingAdmission` still stands (`withdrawAwaitingSeat`), and answers a typed outcome:
`withdrawn` (roster row, queued Welcomes and device rows gone, the open interval deleted - no
exclusion interval is written for someone who was never in; the one record is the seat generation
the Decline moved the group to, `declinedAtSeatGeneration`, see "An Add enrols its people with the
accepted commit" below), `already-admitted`
(a member's Add came first; nothing is touched, so a Decline can never strip an admitted person),
`not-awaiting` (the flag was never set and the server holds no trace of an Add - no `active` device
row, no `admittedAtEpoch`, no queued Welcome: the seat was never an ask, nothing is touched), or
`gone`. All four leave the screen; a refused or failed call keeps the ask. **A Decline holds against
every Add decided before it, through every writer** (ADM-3, 2026-10-25): the gate orders it against
the seat generation the inviting member READ (below), enrols nobody and lifts nothing for it, drops
its admits, and the member-add route that used to undo it enrols nobody any more - see "The commit
is the one writer of a new person". An Add decided after it is a fresh invite and admits. Anything
else keeps the ask, logged with its reason.

**An answer is an answer to THAT ask.** `admitJoinRequest` hands the invite the ask's identity
(`askId`, the seat id); the invitation's first roster read must still find that seat awaiting under
that id, or the Add stops before anything is staged (`removed-meanwhile`) - declined, or declined and
asked again (a NEW ask, another id). A seat no longer awaiting was admitted by another member, and
the invite goes on to find them in the tree.

**The link is an ASK, carried from the server that knows it.** Accepting a link writes the roster row
with `awaitingAdmission = true` (`dm_group_members`, migration 038; only `acceptGroupInvite` sets it),
and the server holds the person outside until a member answers:

- `getDeviceMemberships` says `awaitingAdmission` per row, so the joiner's `requestReAdd` reads
  `awaiting-admission` (`readWelcomeOwedFromRow`) and sends a `welcome_request` instead of an
  external join - the request that raises the ask on a member's device. Nothing is learned by failing.
- The external-join base (`GET`/`PUT .../group-info`) answers **409 `awaiting_admission`** to such a
  person - deliberately not a 403, which older clients read as `NotAGroupMemberError` and retire the
  conversation on - and the commit gate refuses every commit from them, external or member.
- The flag has ONE writer that clears it, `liftAwaitingAdmission`, at ONE door: inside the
  transaction of an accepted commit, for the people its `admits` name (and the target of its inline
  Welcome) that the gate admitted. **A Welcome sent apart lifts nothing since ADM-3** (2026-10-25):
  it lifted for clients that declared no `admits`, but every client at the version floor declares
  them (#1151, `v0.18.28`), and that door was the second half of a Decline being undone - the gate
  refused the person and the Welcome then let them in. `sendWelcome` -> `enqueueForLiveGroup` now
  REFUSES a Welcome whose target seat still awaits (`403 WELCOME_TARGET_NOT_MEMBER`,
  `reason=awaiting_admission`), read under the same row lock (`seatStandsFor`, `requireAdmitted`).
  Only an admitted member can store a Welcome at all: `memberOfGroupKind` does not count an awaiting
  seat, so the asker cannot Welcome themselves.
- An ACTIVE device row is never read as awaiting: the membership reads report the flag only on a
  row that is not `active`, the client's `readWelcomeOwedFromRow` ignores it on one, and the commit
  gate reads such a seat as admitted and logs `[ADMISSION]` at ERROR - the invariant broke upstream.
  The report of `active` is refused with **409 `awaiting_admission`** while the flag stands, so a
  row cannot become active ahead of the lift. The Welcome path reads the roster row `FOR UPDATE`
  (`seatStandsFor`), the lock a commit's lift needs, so a store and a commit cannot deadlock.
- An unanswered ask EXPIRES WHOLE (`expireUnansweredAsks`, in the hourly stale-pending sweep): once
  no device of the person is `active` or pending since the 14-day cutoff, the seat is withdrawn as
  a Decline withdraws it, per seat under its lock; the device-only purge never touches an awaiting
  seat, so it cannot leave a roster row that answers 409 to a fresh ask forever. The stranded-seat
  reports count these seats apart (`awaiting-member`).
- **A seat awaiting a member is not a membership ANYWHERE a caller is checked** (review of #2358,
  B1). Every caller predicate of the controllers reads the seat through ONE helper,
  `callerSeatStanding` (`utils/group-membership.ts`): enrolling or removing someone
  (`POST`/`DELETE mls/groups/:groupId/members`), minting an invitation link, vouching for or
  kicking a device, and reading the roster (`user-members`, `members`; `group-rosters` lists the
  group in `refused`) are all answered **409 `awaiting_admission`** for such a seat. Counted as a
  membership, a person still waiting enrolled an accomplice whose seat read as not awaiting, who then
  read the base and entered by external commit with no member's Add. Leaving is the one thing it may
  do (the removal of its own seat). The re-review (F1) found four reads that never asked the flag;
  they go through the same helpers now: the history (`GET mls/history/:groupId` answers the 409,
  the batch omits the group; `callerSeatStandings`), the exclusion windows, a Decline by a caller
  whose own seat waits (409, never `NOT_A_MEMBER`), and every call route (initiate, room token, ICE,
  ring, ring-end). WHO SHARES a conversation reads one `where` fragment, `ADMITTED_SEAT`: the
  presence audience (both directions) and the call ring's callees, so a waiting seat neither sees nor
  is seen online, and is rung by nobody. Each refusal is one WARN at the 1st, 10th, 100th... repeat
  per (route, group, person) (`refuseAwaitingSeat`), and the client types it at the throw
  (`AwaitingAdmissionError`, a 409 `ApiRefusalError`) on the roster, members, exclusions and base
  reads.
- **The wait is quiet on the server.** The waiting device asks a member on every recovery cadence
  for up to the 14 days of its ask, and an older client meets the withheld base each time: the
  `[WELCOME_REQ]` lines of such an ask and the `[GROUP_INFO] base withheld` line are said at the 1st,
  10th, 100th... repeat per (group, device) (`awaitingAskRepeats`, a `RepeatCounter`), every relay
  still made. The joiner reads "Waiting for a member of X to add you" on the link page
  (`group_join_sent_desc`); the conversation appears once a member adds them.
- **"Holds a leaf" is not "is a member" (review of #2358, P2-2).** A removal deletes the roster row
  BEFORE the member's Remove commit lands; if that commit never lands, the removed person keeps a
  leaf. Following a link later, they are re-added automatically: `automaticAdmission` reads their
  user in the tree as `member-device`, and the commit's `admits` lifts the flag. Open in
  [backlog](../backlog.md#p2---a-removed-member-whose-leaf-survived-is-re-added-automatically-by-a-link-review-of-2358).
- **"Only through a member's decision" holds from a client floor**, not from this build:
  a member client older than the rule still auto-Adds a link joiner, and that Add legitimately lifts
  the flag. It holds once `minClientVersion` floors at this build, with migration 038 deployed with
  it ([legacy-compatibility](../legacy-compatibility.md)).
- **WHEN THE FLOOR IS RAISED (user, 2026-10-24): once BOTH stores serve the version carrying this
  change** - not at the deploy, not on a date. Until then an older client meets the tolerated
  **409 `awaiting_admission`** path above (it falls back to asking a member) and an older member's
  automatic Add is honoured through the Welcome lift. That tolerance is the shim, and its removal
  condition is that floor, with no calendar date.

The other reading was refused: treating the link as the member's decision would mean a member's
device honouring a server-written flag, the very trust in server rows this policy removes.

**A new person who entered by their own commit is made visible.** It shows in the signed commit as a
`DeviceEvent` whose `addedBy` IS the admitted leaf and whose `memberAlreadyPresent` is `false`
(`entersUninvited`, pinned in Rust by
`an_external_commit_by_a_new_user_is_recorded_as_signed_by_the_device_it_admits`). In a conversation
- decided on its row, loaded or durable, never on the session-local key-group set - the client writes
"X entered the conversation without being added by a member" (`chat_system_uninvited_entry`, owed
durably until the row loads), logs it at ERROR and reports it once (`POST mls/uninvited-entry`,
`[UNINVITED_ENTRY]` in the delivery log). Never in a community or salon key group, where an external
commit is how every member enters. The shape is `sender-mismatch`'s: a measurement, read on
production before anything is decided about such entries. The receiving side is hardened in a
second step.

**A legitimate rejoin is not written, only counted.** The report carries a `kind`
(`UninvitedEntryKind`): `returning` when this device saw the same user leave the tree at an earlier
epoch (`removalEpochs`), `direct-peer` for the other person of a 1:1 conversation, `new-person`
otherwise - and only `new-person` is written and logged at ERROR. A departure read that fails keeps
the entry owed rather than guessing. A device that never saw the departure still reads a returning
member as `new-person`. The server takes the report from a member of the group only (403
`not-a-member` otherwise), accepts `kind` from that list alone, and writes one line per
(group, entrant, epoch), so N members reporting one entry make one line, not N.

## Key packages

### The two kinds of key package

A device publishes two kinds, and **the difference is in the crypto, not in the naming**. Both are
minted by one builder, `MlsManager::build_key_package(last_resort)`
(`frontend/mls-core/src/state.rs`), reached through two named entry points; the TypeScript side has
one caller for both, `mintKeyPackages()` in `frontend/src/lib/mls-client/keyPackages.ts`.

| | Static fallback | One-time prekey (OTKP) |
|---|---|---|
| Server row | `key_package`, one per device, replaced on each connection | `one_time_key_package`, a pool, FIFO |
| Served when | the pool is empty - to **every** caller, unchanged | there is one left; the row is deleted with the claim |
| MLS marking | `last_resort` extension, `LastResort` in the leaf capabilities | none |
| After a join | private bundle **kept** | private bundle deleted by `into_group` |

**Why the fallback must be `last_resort`, and what it cost to find out.**
`resolveKeyPackagePayloadForDevice` returns `otkp?.keyPackage ?? device.keyPackage`, so an empty
pool means the same bytes go to every peer until the device next connects. That is deliberate -
without it, a device whose pool ran dry could never be added to a group again. But OpenMLS deletes
an ordinary KeyPackage's private bundle the moment a Welcome built on it is processed
(`openmls-0.8.1/src/group/mls_group/creation.rs:605`), so an unmarked fallback was good for exactly
one join. Measured on the Mi 9T on 2026-09-06: a device re-entering ten groups at once got ten
Welcomes built on the one fallback the server had, joined the first, and answered the other nine
with `NoMatchingKeyPackage [n_secrets=3..5]` - nineteen times. It then sent another
`welcome_request`, the responder kicked and re-added it on the same dead package, and nothing broke
the loop until the next reconnection replaced the row. From the notification shade the same event
reads `Nouveau message de <name>` with nothing under it: the group could not be joined, so the
message could not be decrypted.

`frontend/mls-core/tests/last_resort_key_package.rs` pins both halves - the fallback must survive
being served twice, the pool prekey must not - and
`apps/chat-delivery-service/src/controllers/devices.controller.static-fallback.spec.ts` pins the
server's side of the promise, so the pair cannot drift apart silently.

### The 84-day lifetime outlives the device

A KeyPackage carries a `Lifetime` (OpenMLS default: 84 days, `not_before` backdated one hour for
clock skew), and the leaf node minted from it carries that same lifetime into the ratchet tree. A
device that keeps sending replaces that leaf (every commit it builds carries a path, and the
[periodic leaf refresh](#the-periodic-leaf-refresh) makes one at least every 7 days of activity) and
the replacement has no lifetime at all. A device that stops running does not.

So a device that stops running - wiped, reinstalled, abandoned, or reset through the button on the
login page - leaves a leaf behind in every group it was in, and on day 85 that leaf elapses. Purging
the device's server-side footprint does not touch it: `DELETE mls/devices/:userId/:deviceId` deletes
routing rows, and a ratchet tree is not a routing row. What takes the leaf out is a member's commit:
the stray-leaf collector removes the leaf of a device the server names as REVOKED
([below](#a-revoked-devices-leaf-is-removed-from-every-conversation)), and only that.

**Until 2026-09-11 that elapsed leaf closed the group to everybody else.** RFC 9420 7.3 recommends
validating leaf lifetimes when a ratchet tree is IMPORTED, and OpenMLS did so on both paths a device
takes when it holds no state for a group:

| Path | Where the tree is imported | What it used to do |
|---|---|---|
| `join_by_external_commit` | `MlsGroup::external_commit_builder().build_group(...)` | refused with `PublicGroupError(LeafNodeValidation(Lifetime(NotCurrent)))` |
| `process_welcome` | `StagedWelcome::build_from_welcome(...)` | refused with the same error |

Both are in `frontend/mls-core/src/welcome.rs`, and both now call `skip_lifetime_validation()` on
the builder. The two paths are the ONLY two ways out of a missing group, and the Welcome is the
repair for a failed external join - so one dead leaf closed the door and the door behind it.

Measured on production 2026-09-11: `Lifetime { not_before: 1781347172, not_after: 1788608372 }` on
one member's device, elapsed six days earlier, refusing rung 2 of the recovery ladder for a
conversation whose other participants were all present and healthy.

**What is NOT dropped.** `validate_leaf_node` (`openmls-0.8.1/src/group/public_group/validation.rs`)
forces `LeafNodeLifetimePolicy::Verify`, so every Add proposal still refuses an expired KeyPackage,
as does `add_members_bulk`'s own `KeyPackageIn::validate` before OpenMLS ever sees it - that one
reports the refusal by index in `skipped` rather than failing the batch. Admission is where the
question "may this key material enter a group" is actually decided; the tree check only re-took that
decision, epochs later, against a clock that had moved, and billed the refusal to a member who had
nothing to do with it. OpenMLS says as much at the check itself and exposes the builder for it
(openmls#1810).

`frontend/mls-core/tests/expired_leaf_in_tree.rs` pins the pair. It mints a "ghost" KeyPackage with
an explicit short lifetime (openmls directly, since `MlsManager` only mints the 84-day default),
adds it while it is still valid, waits for it to elapse, and then asserts that neither an external
join nor a Welcome is refused - and that a KeyPackage already elapsed is still refused at admission,
beside a good one, so the assertion distinguishes "that package was refused" from "the batch fell
over". Remove either `skip_lifetime_validation()` and two of the three tests fail with the
production error.

### The periodic leaf refresh

Post-compromise security in MLS comes from a member replacing its own leaf's encryption key: once it
has, an attacker who copied the old key material stops reading new epochs. Every commit a device
builds already does that (openmls gives every member commit a path - an Add or a Remove refreshes the
committer's leaf too, pinned in `frontend/mls-core/tests/self_update.rs`), so a device that commits
often is already refreshing. The periodic refresh covers the device that only SENDS.

**The commit.** `MlsManager::stage_self_update` (`frontend/mls-core/src/self_update.rs`) stages an
empty commit with a forced path: no proposal store is consumed (a queued external proposal is never
swept in), membership is unchanged, the leaf's HPKE key and path secrets are new. It goes through
`BaseMlsService.runCommitTransaction` like every other commit - stage, server validation
(`submitCommit`), then merge or clear, with the successor base attached - so the single-writer and
commit-gate rules hold unchanged. A refused refresh clears its pending commit and retries nothing.

**A submit with no answer (every commit, not only the refresh).** A transport failure or a non-OK
answer to `submitCommit` used to leave the staged commit pending; the next checkpoint persisted it,
and openmls then refused every commit the device staged in that group. Reading the server's log at
that moment does not answer it either: an empty log says "not landed YET" as well as "never", so a
clear decided from it races the request still in flight. So the answer is made definitive
(`commitSubmission.ts`): `runCommitTransaction` RESUBMITS THE SAME BYTES, and the commit gate answers
a commit it already accepted from that device at that base epoch as accepted again (`duplicate`,
[chat-delivery](../services/chat-delivery.md)). Accepted or duplicate -> merge; a refusal (another
commit took the epoch, or a 4xx, sent only before the gate) -> clear and catch up; still no answer
(a transport failure, a 5xx, or `concurrent_commit` - a lock our own first request may hold) -> the
staged commit is KEPT (already on disk, see below), and `CommitOutcomeUnknownError` (a `TransportFailureError`)
is thrown. Until a resubmission answers, the group takes no commit and no send. The resubmission runs
at the next gateway connection (before the pending messages are drained), before the next send or
commit in the group, and a commit replay settles it from the log only when the log holds a row AT its
base epoch, which is decided for good. No clock decides anything.

**A 401 is not a refusal of the commit; it is a stale bearer (TOK-1, 2026-10-25).** On `/api/mls` every
401 is the auth guard's, given before the gate, so the request did nothing - a fact of today's server: a
handler-level 401 added there would make the resend a second submission, which the gate would still
answer `duplicate`. `MlsDeliveryApi` applies the one 401 rule of first-party calls (`renewOn401.ts`,
[sessions](../sessions.md#a-401-renews-the-token-and-sends-the-same-request-once---one-rule-every-caller)):
the token is renewed and the SAME bytes are sent once more. The renewal is bounded by the submission's
`write` deadline (raced against its signal), so the lock-hold budget holds; a renewal still running at
the deadline ends the request as a `RequestDeadlineError`, which is no answer. Before, the 401 was an
`ApiRefusalError` and cleared the staged Add, the group left at its old epoch. A 401 on the renewed
token too is `DeliveryRefusedRenewedTokenError` - an `ApiRefusalError` with status 401, never a logout
(the delivery guard also answers 401 for its own faults) - so it reads like any 401: a definitive
refusal of a first request (nothing reached the gate: the stage is cleared, nothing resubmitted) and
UNKNOWN on a resubmission. A renewal that FAILS after the 401 - a refresh answered 5xx, or one nobody
answered - is `DeliveryRenewalFailedError`, the same 401 reading: the server answered, the bytes never
reached the gate, so a first submission is cleared at once rather than resubmitted into the same 401
and kept as unknown; never a logout (`BaseMlsService.commit401.test.ts`). One case stays unknown: a
renewal still running when the submission's deadline aborts it ends as a `RequestDeadlineError`.

**No submission holds the MLS lock unbounded.** Every submission - the first and each resubmission - is
awaited INSIDE the global MLS lock, which guarded the incoming processing of every group too until
DUP-6 ([below](#a-commit-waiting-on-the-network-lends-the-mls-lock-to-other-groups-frames)), so a
POST hung on a half-open connection or a captive portal froze decryption in every conversation. Since
the periodic refresh makes an unasked commit ordinary, `submitCommit` runs under the `write` head
deadline (`requestDeadline.ts`: 30 s plus the time its body needs to leave). Its expiry is a
`RequestDeadlineError`, a transport failure - NO ANSWER, never a refusal - so it takes the path above:
the same bytes are resubmitted once, and a second expiry keeps the stage as unknown. The deadline does
not decide the outcome; the next resubmission does (`BaseMlsService.unresolvedCommit.test.ts`, "a
commit gate that never answers"). ONE budget bounds the whole hold of a transaction, settlement and
rebuilds included: `COMMIT_LOCK_HOLD_BUDGET_MS`, three `write` deadlines (the settlement's
resubmission, the first request, its resubmission - each deadline also stretched by its body's upload
time), read before each request and again after the checkpoint that precedes the first. A request it
does not let start leaves the outcome unknown, or - for a first request - is never sent, its stage
cleared and the commit refused (`lock_budget_spent`).

#### A commit waiting on the network lends the MLS lock to other groups' frames

**Found by rig row DUP-6 on 1.4.1-alpha.4 (2026-10-25), reproduced twice.** An Add in group A was
posted and got no answer for two `write` deadlines (~62 s). A frame for group B arrived at once and
opened its drain (`Disk writes deferred (bulk ingest depth=1)`), then waited the whole minute for the
mutex: it was decrypted, displayed and ACKed in the millisecond the resubmission gave up, and the
server's push fallback (`still unACKed after 10 s`) had duplicated it through FCM meanwhile. The cause
was the drain's `acquireMlsLock` (`mlsPerGroupScheduler.ts`) waiting on `runCommitTransaction`'s
`runUnderMlsLock`, held across `submitRecorded`.

**The commit now LENDS the mutex while a request of it is on the network**
(`MlsPerGroupScheduler.lendMlsLockWhile`, called by `submitRecorded`, so the first request, every
resubmission and a settlement's request all lend). The rules, each enforced by the scheduler rather than
by its callers:

- **Only the commit holding the mutex for that group lends** (`runCommitUnderMlsLock(groupId)` names
  the group as the mutex is granted, synchronously); any other loan is refused before the request
  starts.
- **Only the drain borrows, one frame at a time, never for the committing group nor for an
  unaddressed frame** (`acquireMlsLockForFrame`). Every other acquirer - a catch-up that swaps the whole
  client, a Welcome, a settlement, another commit, a key-package worker - stays exclusive of the commit
  exactly as before.
- **While a commit holds the mutex the drain holds back what would have to wait for it anyway**: the
  committing group's frames (another member's commit applied there would clear our stage in flight),
  unaddressed frames, and a Welcome with the frames queued behind it in its group (the Welcome handler
  takes the mutex exclusively). They stay in their buckets, still pending - so `isIdle` and
  `isGroupIdle` do not change meaning - and the commit's end resumes them
  (`BaseMlsService.resumeFramesHeldByCommit`). The drain's restart guard reads `hasRunnableWork`, not
  the pending count, so a held-back frame never makes it spin.
- **A frame picked BEFORE the commit was granted does not hold the drain for the whole commit.** The
  pick runs before the mutex wait, so with an exclusive holder X ahead and commit A queued behind it,
  the drain can pick a frame of A (or an unaddressed one) while nothing names A yet, and queue it for
  the mutex behind A. As A is granted, every queued frame it holds back is BOUNCED - its acquisition
  resolves without the mutex - and the drain puts it back at the front of its tier and goes on with
  B's frames under the loan. One predicate (`isFrameHeldBack`) decides the pick, the bounce and,
  through them, the loan: a frame of A never waits while A holds, so it can never borrow A's loan and
  apply another member's commit with A's stage in flight. The put-back frame keeps its place WITHIN
  its tier (the front, where it was picked). The order across tiers is the tiers' own. In `web` mode a
  Welcome shares the `messages` tier, so the frame goes back ahead of it. In `tauri` mode the tiers
  are `control`, `welcome` and `messages`, picked in that order. A Welcome for A that arrives while a
  `messages` frame of A is bounced therefore runs before that frame, which is the precedence a
  Welcome already has over every queued frame of its group in that mode.
- **The mutex is taken back before the merge or the clear**: the reclaim waits for the frame being
  applied under the loan and admits no new borrower - `closing` is what refuses one in the window
  between the borrower's release and the commit dropping the loan, where `borrowed` is already false.

**The invariant a borrower must keep, or the two deadlock for good:** a borrower never awaits anything
the commit's caller holds outside the mutex, nor anything that needs the commit to finish - A's send
barrier, a send of A, a lock or a promise A's caller keeps. A waits in the reclaim for the borrower and
the borrower would wait for A. The drain's frames keep it because the pipeline awaits no send (below);
any new await in the frame path is to be read against it. The reclaim wait goes through the drain's
hang reporter: `[QUEUE] STUCK in the reclaim of the MLS mutex lent by the commit of <group>` every
minute it lasts, and nothing is cut.

**A slow borrower spends A's lock-hold budget - a behaviour change.** The reclaim waits for the
borrower, and `COMMIT_LOCK_HOLD_BUDGET_MS` keeps running: a borrowed frame that awaits the network
inline (the rung-1 replay of a commit, for one) can leave too little budget for A's resubmission, so
`mayStartCommitRequest` refuses it and the outcome is kept as unknown (`CommitOutcomeUnknownError`, the
stage kept, settled later) where before the PR it would have been resubmitted at once. Nothing is lost
- the unknown path is the one a second deadline already took - but the rig should watch for the line
`the commit of <group> has its answer - waiting for the frame applied under its loan` followed by an
unknown outcome: that pair is this cost, measured.

**What is left: a Welcome picked before the commit was granted.** Its handler runs a network preamble
unlocked (`getGroupMeta`, the recovery checks) and then takes the mutex EXCLUSIVELY. A commit granted
during that preamble makes the Welcome - and the drain inside it - wait for the whole commit, the old
stall, for one Welcome. It is not bounced, because the handler is half-way through and cannot be put
back; and it does not borrow, because installing a group (a drop of its evicted state, `processWelcome`,
a persist, the replay) is not a frame of another group and the loan's safety argument does not cover
it. Closing it means a handler that can stop before its locked section and requeue the Welcome, in
`setupMessageHandler.ts`.

**The drain overlay counts what the drain can apply** (`getRunnableCount`), not what is pending: a
frame a commit holds back is not this drain's work.

**Why the state stays consistent.** The stage and its record are on disk before the first request
leaves (`checkpointStageBeforeSend`, unchanged, before any loan). A borrower decrypts in group B only,
so it can neither merge nor clear A's stage; a checkpoint written during the loan (the drain's own, at
its end) holds A's stage AND B's ratchet, the same state a crash before the merge already had to
settle. A frame of B is applied exactly once - the drain still applies one frame at a time and the
loan admits one borrower. The epoch-send barrier keeps its lock order: a borrower can see A's barrier
raised but never waits on it, because the pipeline awaits no send (the history answers run after the
mailbox drained), which it already could not, a send being able to settle a commit under the mutex
the drain holds ([mls-desync-prevention](mls-desync-prevention.md)).

**What is NOT lent:** the stage, the checkpoint before the first request, the merge, the clear, a
refused commit's catch-up (`catchUpOnRefusedCommit`, network AND MLS writes) and every other
network wait taken under the mutex outside a commit - a frame waits for those as before. Pinned by
`mlsPerGroupScheduler.test.ts` ("a commit lending the mutex across its network round trip") and
`BaseMlsService.crossGroupDrain.test.ts` (the real transaction and drain: B decrypted and ACKed while
A's answer is held; A's own frame applied only after its merge; a kept-unknown commit settled after
three loans).

**The server's commit lock lives 5 s; the client waits 30 s - so a resubmission can overlap its own
first request.** The Redis lock (`EX 5`, `messaging.service.ts`) expires while a first request
stalled inside its transaction (waiting on the seat lock, say) is still running. The resubmission
then passes the lock, reads the base still active, waits on the group row, and when the first
request commits it loses the advance (`EpochAdvanceLost`) - while a third device's commit, queued
behind, may already have moved the epoch past `base + 1`. A key group's Add with admits is refused
even earlier, by the admits pre-check, before the lock. **So the gate asks its commit log before
EVERY refusal on the epoch or a seat** (`answerIfAlreadyAccepted`): the admits pre-check, the strict
gate, and the lost or rolled-back advance (`EpochAdvanceLost`, `SeatClaimOvertaken`,
`WelcomeSeatGone`). The row is keyed by base epoch and written in the transaction that moves the
epoch, so when this request finds it holding the same bytes from the same device, the answer is
`duplicate`, whatever epoch the group has reached. On a resubmission, then (`commitSubmission.ts`):

- `epoch_mismatch` is definitive at any epoch: our own commit would have been answered `duplicate`;
- a `409 SEAT_CLAIM_OVERTAKEN` is UNKNOWN: the stage is kept, never cleared and never rebuilt, and the
  next settlement decides. The gate reads seat claims per REQUEST, so the 409 refuses only the copy
  that got it - a first request still on its way reads its own claims and may land. Only a FIRST
  request the gate answered `409` is rebuilt. A REAL 409 (an eviction overtook the claim) costs one
  settlement, not the group: the next resubmission reads fresh claims too, and is answered for good
  - accepted, `duplicate`, or refused on the epoch.

**One store, one call.** What a resubmission needs - the commit, its successor base, its Welcome,
and the client's intent (whom it excludes, admits and removes) - is kept BESIDE the staged commit in
the MLS state itself (`mls-core/src/pending_submission.rs`), and written by the SAME platform call
that stages the commit (`*_recorded` in the crate; the WASM stage bindings and the Tauri stage
commands take the intent as an argument). Every commit that goes through the gate is staged this way,
the one-commit device replacement (`replace_device_recorded`) included: its record carries its
Welcome, so a settled replacement owes it to the device it re-admits as an Add does. It used to be two calls, and a checkpoint - which does not
take the MLS lock - could run between them and save a staged commit with no record; a device killed
after sending then read "no record" as "never sent" and cleared a commit the server had accepted. One
call leaves no such moment. The request is composed from the record (`composeSubmission`), so the
first submission and every resubmission are the same bytes. A staged commit found with no record was
never submitted through the gate, and is cleared. The crate ties the record's life to the staged
commit: a new stage, the merge, the clear, a forget, or another member's commit (which clears ours)
each end it, and only live ones are saved - in a `#[serde(default)]` field of the state, so an older
state loads with none and an older build drops the field when it saves. The client keeps a derived
in-memory index of the groups holding one, so a send does not cross into the platform to ask.

**On disk before the first request leaves.** One call makes the stage and its record inseparable;
it does not make them durable. `runCommitTransaction` therefore awaits a structural checkpoint
between the stage and the first `submitCommit` (`checkpointStageBeforeSend`). Before that, a crash
after the send and before the next checkpoint reloaded the state from BEFORE the stage: the server
might hold the commit, and the device could neither merge it nor resubmit it (it fell to rung 1 or 2).
Now any crash after the send reloads the stage and its record, and the resubmission at the next
connection merges or clears it. The checkpoint the kept-unresolved path used to await afterwards
is gone: the state it wrote is already on disk.

**A checkpoint that throws sends nothing, and WHERE it threw decides the stage** (2026-10-23), read
from the type (`checkpointWroteNothing`, `utils/hex.ts`):

- **It stored nothing** - refused by the version guard or an ended document
  (`MlsStateWriteRefusedError`), or failed before anything was stored (`MlsCheckpointNotWrittenError`:
  the export and seal, or the IndexedDB transaction, which stores all of it or none). The commit never
  left and this write did not save it, so the stage is CLEARED and the failure is definitive
  (`CommitStageNotSavedError`). Kept unknown instead, a checkpoint that keeps failing (a full quota)
  blocked every send in the group for the rest of the session. If the clear itself fails, the stage
  stays and the outcome is unknown.
- **Anything else** may have thrown after its write landed (the native checkpoint is one call, so its
  failure is always this kind), and the stage may be on disk; clearing it and reporting a failure was
  contradicted by the next reload, whose settle landed the commit. It is kept, reported as
  `CommitOutcomeUnknownError` like an unanswered commit, and the settle that decides it awaits its own
  checkpoint before the resubmission: no request leaves carrying a commit that is not on disk. That
  settle checkpoint is paid only when a kept commit is settled.

**A follower tab does not commit** (`FollowerTabCommitError`, refused before anything is staged, by
`externalJoin` too - a join is a commit - and by `createGroup`, at the service's own entry: a group
created in a follower's copy is one the leader never holds). Its
state is a copy loaded once: the version guard refuses its writes once the leader has written, so the
checkpoint above would fail on every follower commit; and before that checkpoint existed, a commit
sent from a follower moved the group past the state the leader keeps, because the leader cannot read
a commit of its own leaf back (`OwnPrivateMessage`). Commits are reached from a follower's UI
(`groupActions.ts`, `groupCreation.ts`, `actions.ts`); refusing them by the leadership fact is the
gate the outbox already applies to sends. The member is told, by type: a creation answers the
`follower-tab` refusal, and an invite or a removal shows the same sentence
(`reportFollowerTabRefusal`, `conversationRefusalMessage.ts`) - do it in the main tab. A community's
or a salon's key group refused this way (`leaveKeyGroupToMainTab`, `followerTabKeyGroup.ts`) tells
the member on a gesture (creating a community or a salon, joining a salon) and goes on without the
group; on a load it is logged and the load goes on, since the main tab enters it.

**Cost: one checkpoint per commit, awaited under the MLS lock**, which blocks decrypts and sends in
every group while it runs. The live web path is the WASM ChaCha20 seal
(`MLS_STATE_SEAL_V2_WRITER_ENABLED` is still `false`): **~196-200 ms for a 7.7 MB state in desktop
Chrome** (seal + IndexedDB put, [performance-audit](../frontend/performance-audit-2026-10-12.md));
the v2 WebCrypto seal's ~47 ms is not live yet. On a phone it is far more: the Mi 9T capture of
2026-10-13 (a DEBUG build) read **~1.4-2 s per checkpoint**, with a checkpoint in flight ~93 % of the
time after a sign-in ([community-open-slowness](../frontend/community-open-slowness-mi9t-2026-10-13.md#finding-2---after-a-sign-in-the-checkpoint-runs-93--of-the-time-and-each-one-costs-more)).
A request for durability made while a checkpoint is running waits for the NEXT one, so one commit
costs up to two checkpoints, and **a burst of N commits serialises to ~2N under the lock** - on that
phone, several seconds of blocked decrypts for a handful of commits. Commits are rare next to
checkpoints (the fleet ceiling is ~200 a day, see the leaf-refresh interval above, against 247
checkpoints in 432 s on ONE phone after a sign-in), but the burst cost is real where commits cluster:
a group creation adding several devices, a roster reconcile. **Owed: a release-build phone
measurement** of a commit's checkpoint (Mi 9T and iPhone 12). Desktop native release figures
(`mls-core/tests/heavy_state_checkpoint.rs`, 2026-10-22: export + seal 12.3 ms at 7.7 MB, without the
file write) are a floor, not a phone.

**A record that cannot be read decides nothing.** "No record" proves the commit never left; a record
that does not decode (the crate's CBOR, or the intent inside it) proves nothing, and the bytes a
resubmission or a log comparison would need are the unreadable part. Clearing would be one guess,
merging the other. So the staged commit is KEPT and the group is marked in the epoch-gap registry,
which keeps sends out of it and hands it to the sync watchdog's rung 2 (forget + re-Welcome) - the
one repair right whichever way the commit went - with a `[COMMIT] ... UNREADABLE` line at error level.

**An Add accepted only through a later resubmission still delivers its Welcome, once**: the Welcome is
a separate request after the accept, and the call that staged the Add is gone by then, so the
settlement sends it. The owed Welcome is STATE (`mls-core/src/owed_welcome.rs`): the merge writes
"owed to these devices", with the ratchet tree of the epoch the Add created, in the same platform call
(`merge_pending_commit_owing_welcome`); the client awaits a checkpoint, sends, and clears each
recipient as its send returns. A reload mid-settlement therefore finds the Add merged and only the
uncleared recipients owed - it never re-merges and re-sends the whole Add - and a failed send stays
owed for the next connection. A joiner handed a copy of a Welcome for a group it holds treats it as a
redelivery before the core sees it (`setupMessageHandler`); the core itself refuses such a copy
(its key package is spent) and leaves the group untouched (`mls-core/tests/owed_welcome.rs`).

**EVERY accepted Add is merged owing its Welcome, not only a settled one (DUP-7, 2026-10-25).** The
transaction that READ the accept (`runCommitTransaction`, a first answer or a `duplicate` to its own
resubmission) used to merge plainly and hand the Welcome to its caller: the obligation lived in the
caller's hands alone, so a send that failed and a reload after the merge reached disk lost it, and
only the invitee's own `[READD]` external join let it in. Both paths now go through ONE merge
(`BaseMlsService.mergeAccepted`): whichever state reaches disk holds either the stage and its record
(a settlement re-derives the Add) or the merge and its owed Welcome (the connection drain,
`deliverOwedWelcomes`, sends it) - never the merge alone. The caller still sends the Welcome it was
handed, and **`sendWelcome` is where the obligation is consumed**: the server's answer - stored, or
the terminal `WELCOME_TARGET_NOT_MEMBER` - clears that recipient FROM THE ENTRY CARRYING THOSE BYTES
(`welcome_delivered` matches the Welcome, never the device alone), whoever sent it, and hands the
change to the next checkpoint. So the connection drain now competes with a live Add's own send; that
is correct because a send of the same bytes to the same device already in flight is awaited, never
repeated, and the server stores a copy once (below). A group can owe the Welcomes of SEVERAL Adds,
so a group's record is a list, one entry per Add; a device admitted again is owed only the newer
Welcome, and an older Welcome answered late clears nothing (a record of one bare entry, written by
an older build, still reads - [legacy-compatibility](../legacy-compatibility.md)). The merge records
the obligation even when the ratchet tree cannot be exported afterwards: the entry carries an empty
tree, said at error level, and the Welcome goes without one, which a joiner opens from the tree the
Welcome itself carries (`a_welcome_opens_without_an_external_ratchet_tree`) - never a merged Add
owing nothing. The connection drain clears every recipient of its pass and schedules ONE persist
after it; a recipient that names no device is a defect of the record, dropped unsent and said as
one, never reported as a server refusal.

#### A device the gate did not admit is owed no Welcome - the commit's answer says so (2026-10-25)

Measured on the rig (DEV-3): a member's pending sweep added a device its owner revoked while the Add
was in flight. The gate accepted the commit and dropped the admit (`ADMIT_REFUSED
reason=no_key_package`: the revocation had purged the key package), and the member sent the Welcome
anyway - a 500, then `Add error ... Could not send the secure invitation` - and every other group's
invitation of that device asked the server again and was told `revoked`, six 404s for one fact. The
accept now carries **`refusedAdmits`** (`{ userId, deviceId, reason }`, every admit the gate dropped,
before or inside its transaction). `undeliverableAdmits` (`BaseMlsService.ts`) says each once and returns
those whose Welcome cannot be delivered - an ALLOWLIST, `no_key_package` alone
(`admitRefusalMakesWelcomeUndeliverable`; NOT `not_enrolled`, which the sender's own
`registerMember` enrols before a Welcome that then lands). `mergeAccepted` owes them nothing,
`addMember` / `replaceMember` hand out no Welcome and name the refusal (`notAdmitted`), and
`addMembersBulk` leaves them out of `addedDeviceIds`, the list every caller welcomes. The pending
sweep registers nobody, sends no Welcome or history, retires the invitation, and answers every other
invitation of that device in the same sweep from that answer - as it now does a `revoked` or
`unregistered` key-package answer, which is about the device, not the group (`expired` is not carried
over). The leaf stays in the tree with no seat; the stray sweep removes it. A `duplicate` answer names
no refusal (the first acceptance decided them and nothing records them), so a settled Add still owes
that Welcome, and its typed refusal ends it: `404 WELCOME_TARGET_UNKNOWN` is
`WelcomeTargetUnknownError`, terminal like `WELCOME_TARGET_NOT_MEMBER` (`isTerminalWelcomeRefusal`),
said at WARN. Tests: `messaging.commit-log.spec.ts`, `add-enrolment.integration.spec.ts`,
`BaseMlsService.unresolvedCommit.test.ts`, `BaseMlsService.notAdmitted.test.ts`,
`actions.pendingNotAdmitted.test.ts`, `mlsDeliveryApi.welcomeRefusal.test.ts`.

**The same Welcome stored twice is stored once.** A re-send after a lost answer is the same bytes,
and the first request may have been stored. `MessagingService.sendWelcome` looks, under a lock that
serialises every store of a Welcome for that device in that group, for a row still queued with that
payload, and answers `queued` without storing again (`[WELCOME] DUPLICATE`); it hands THAT row to
the delivery again, since the first request may have died between its store and its delivery and
the re-send is then the only thing left to arm the live publish and the push - the same row, so
nothing new is queued, and a device that already joined from it takes the copy as a redelivery. A copy
arriving after the joiner consumed the first meets a device holding the group, which takes it as a
redelivery. Pinned by `add-enrolment.integration.spec.ts`.

**What is left.** A commit-log row pruned before the resubmission reads as a refusal: rows are kept
365 days and the last 20 000 epochs of each group (`COMMIT_LOG_RETENTION_MS`,
`COMMIT_LOG_MAX_PER_GROUP` in `messaging.service.ts`), so the window is a commit left unresolved for a
year, or one its group moved 20 000 epochs past. A state saved before this change can hold a staged
commit with no submission that WAS sent (the old lost-answer defect); it is cleared at the next
settlement, and if it had landed that device is one epoch behind its own commit (rung 2).

**Staged only on the branch the server publishes.** The server's gate compares epoch NUMBERS, so a
device that merged a commit nobody else did is at the right number on the wrong branch, and its
refresh would be accepted and break every healthy member. The commits a MECHANISM decides on its
own - `refreshOwnLeaf`, the revoked-leaf removal (`removeMemberDevice`, next section) and, since
2026-10-27, the departed-member removal a roster DIFF decides (`removeDepartedMembers`: the
conversation stray sweep and the key-group roster pass; until then it went through the unchecked
`removeMember`, which stays the path of a removal a PERSON asked for) - go
through ONE check, `BaseMlsService.assertOnPublishedBranch` (`mls-client/publishedBranch.ts`): it
reads the published base (outside the MLS lock) and, under the lock, stages only when its epoch is
ours and our group context - tree hash and confirmed transcript hash - is the one it describes
(`MlsManager::own_context_matches_base`); otherwise nothing is staged and `UnpublishedBranchError`
says why (`no-base`, `other-epoch`, `diverged`). **`diverged` is a fork, and it is handed to the
recovery ladder where it is thrown** (2026-10-23): the group is marked in the epoch-gap registry,
which keeps every send out of it and hands it to the sync watchdog's rung 2 (forget + re-Welcome),
with a `[FORK] ... DIVERGES` line at error level - the route an unreadable submission record
already takes, for the same reason: rung 1 (replaying the log) cannot help a device that is not
behind but beside. The evidence is the base the server stored WITH the accepted commit (strictly
monotonic, so the first base of an epoch owns it); a commit from a client too old to carry one
leaves the base to a holder's repair, which is the one way that base could itself be a branch.
**The base is read where the group keeps it** (`groupInfoChannel`): a key group's lives on
social-service, and chat-delivery's base route refuses a key group by construction, so a check
reading there failed every key-group removal before comparing anything. Reading it through the scope
transport means **`diverged` now reaches key groups too**, which widens the forked-holder P2 in
[backlog](../backlog.md#p2---a-forked-holders-republished-base-can-send-honest-members-to-rung-2-review-of-2269-2026-10-24-not-built).
**A conversation that never published a base** has nothing to compare against: its departed-member
removal is staged as before the check (logged), because refusing would keep the departed member's
leaves forever - nothing publishes a base on a sweep's behalf; a key group's base is published with
the group, so its absence stays a refusal. Measured 2026-10-27 on production: every one-to-one
conversation and all but one group conversation have a base.
The **signature key is not rotated**: one device key signs every leaf and every KeyPackage of the
device, and a stolen signature key is answered by revocation (next section), not by a refresh.

**The trigger is durable state, not a timer.** After `sendMessage` delivers a conversation frame -
`DELIVERY.visible` or `DELIVERY.mutation`, an allowlist by identity, because a seed is shaped exactly
like a mutation and an addressed seed is a fresh object - the service hands the group to
`refreshLeafIfDue` (`frontend/src/lib/mls-client/leafRefresh.ts`), outside the send barrier and
single-flight per group. It refreshes only when the leaf is DUE:

| Leaf age basis | Source | Due when |
|---|---|---|
| Admitted from a KeyPackage | `not_before + 1 h` read from the tree (`own_leaf_minted_at`), and an observation OF THAT LEAF in the ledger | the later of: older than the interval, and the observation plus the offset |
| Replaced by an own commit | the ledger `mls_leaf_refresh:<userId>:<deviceId>` (`{groupId: {at, epoch, leaf}}`), written after EVERY merge of an own commit (`mergeAccepted`) and external join, by ONE writer (`noteOwnLeafReplaced`) | older than the interval |
| Replaced by a commit, observed (no refresh of ours on record) | the observation `{at, epoch, observed: true, leaf}` | the observation plus the offset |
| No entry, an entry naming ANOTHER leaf (or none), or one dated in the future | first sight: an observation is recorded | never on first sight |

**Every entry names the leaf it dates** (`leaf`: the leaf's HPKE key, `own_leaf_encryption_key`,
read after the merge), and an entry is read only for the leaf it names. The ledger is in
`localStorage`, which Chrome commits to the profile LAZILY: a write made 2 s or 4.5 s before a hard
kill of the browser was lost, one made 7 s before survived, and an IndexedDB write made with it
survived in every case (measured 2026-10-25 on a fresh profile; Chromium also rate-limits those
commits, so the window can be longer on a busy page). The merge it follows is in the MLS state, on
disk as soon as its checkpoint completes. KILL-2 on `1.4.1-alpha.4` killed the browser in that gap
twice in ten runs: the merge survived, the entry did not, and the relaunch read the entry the disk
kept - armed due, written for the leaf the merge had REPLACED - so its first send refreshed a leaf
seconds old (two extra commits on the server, each accepted at the next epoch: no fork, one commit
too many). Naming the leaf lets the state itself say which entry describes it, whatever reached disk;
an entry of a former leaf reads as a first sight, the direction that costs no commit. Pinned by
`leafRefresh.test.ts` ("a date written for a FORMER leaf ...") and
`mls-core/tests/self_update.rs::the_own_leaf_key_names_the_leaf_only_this_device_commits_replace_it`
and `::the_own_leaf_key_moves_on_an_add_a_remove_and_an_external_join` (every own commit moves
the key, so every merge's entry names a new leaf).

**The upgrade costs one first sight per group per device, by design.** Entries written before #2489
name no leaf, so the first send after the upgrade reads each one as a first sight: the leaf is
observed again and its schedule restarts at that observation plus the offset - up to about seven
extra days before its next refresh, once, in the direction that costs no commit.

**The observation is written for the leaf in the state when it is written.** The decision runs
outside the MLS lock, and an own commit can merge while it awaits; that merge dates its own leaf, and
an observation of the leaf read before it would overwrite the entry with a leaf already gone (a
false "FORMER leaf" line at the next send). So the leaf is read again just before the write, with no
await between them, and a leaf that moved writes nothing (`leaf-moved`). An ACTIVE group whose tree
holds no leaf of this device is not an inactive group: it is a defect, reported as `no-own-leaf` at
warn level once per group and epoch, never once per send. Pinned by `leafRefresh.test.ts`.

**The first refresh is spread, or it is a herd** (review, 2026-10-23). The day this ships, every
leaf is older than the interval, so a decision on age alone makes every seat refresh at its first
send: ~1600 commits in the first week, back to back in the 109-seat group, where a slow device
keeps only two past epochs (`max_past_epochs`) and loses the frames sealed in the epochs it
skipped. So a leaf this device holds no refresh of its own for is first OBSERVED - a ledger entry
written at its first send, naming the leaf by its key, never due then - and its first
refresh is owed at the observation plus an offset in `[0, 7 d)` derived from `(deviceId, groupId)`
alone (`leafRefreshOffsetMs`: FNV-1a with MurmurHash3's finaliser, `utils/hash32.ts`, the hash
`historyRangeOf` already used). No clock and no random draw per run choose the day: a reload, a
second tab or a retry read the same one. The 109 seats of one group land on ~16 a day instead of
109 on day one (`leafRefresh.test.ts` pins the spread and the determinism). After its first
refresh each seat's next one follows its own, so the spread holds without being re-applied, and a
young leaf (a fresh admission) is still owed at its own seven days - the offset only ever delays.

It skips a community key group, a group this device was removed from, a group in an epoch gap (the
[recovery ladder](mls-recovery-ladder.md) owns it), a group HELD by something that needs its epoch to
stay put (`holdLeafRefresh`: `CallService` holds its call's group from the ring until the call is
over, because each end derives the media keys from the CURRENT epoch one after the other - another
device of either user is not held, see [calls](../frontend/modules/calls.md)), and a second attempt at the epoch a first one
failed at in this session - the epoch moving is what makes another attempt different. The ledger is
capped at 512 groups and is swept with the account's local keys.

**The interval is read on this device's clock, and that is acknowledged rather than derived away.**
It is a duration, and no durable MLS fact measures one: an epoch moves on commits, so a quiet group
would never be due and a busy one would be due hourly. What a WRONG clock would mean: it decides only
WHEN a refresh is owed, never what a commit contains. A clock ahead makes refreshes early - at most
one per group per forward jump, since the refresh it causes is dated by the same clock; a clock
behind makes them late. A ledger date in the FUTURE (a clock that was ahead has come back) is not
believed - the leaf is observed again - so the delay is bounded by one interval rather than by how
far ahead that clock was. The cost of a wrong clock is therefore timing, bounded on both sides, and
never traffic beyond one refresh per group per jump.

**Why 7 days.** It matches the 7-day cap of a Graine session, so a compromise of either half heals in
the same bound, and it is twelve times inside the 84-day leaf lifetime. A refresh is owed only after
ACTIVITY, so a silent device adds nothing.

**What it costs, on the fleet measured 2026-10-21** ([dm-vs-community-encryption](dm-vs-community-encryption.md)):
at most one refresh per device seat per group per 7 days, and only for a seat that sent.

| Scope | Seats | Ceiling (every seat sends weekly) | Today's commits |
|---|---|---|---|
| 236 one-to-one conversations | median 6 seats | ~200 commits/day | ~30/day (903 per 30 days) |
| 15 group conversations | max 109, median 11 | ~15.6/day for the largest alone | ~8/day (241 per 30 days) |

The ceiling is not the expectation: only seats that send count, and an own commit (Add, Remove)
already resets the clock. A commit races like any other: a lost epoch race is a refusal, logged, and
the next send after the epoch moves tries again.

**Community key groups are excluded, deliberately - re-decided on main's rotation rule
(2026-10-23).** Since 2026-10-22 a key group's seeds rotate on a DEPARTURE, not on every epoch
(`graineOutboundVerdict`, [graine-removal-tracker](graine-removal-tracker.md)), and a refresh is not
one: it removes no leaf, brings no user and keeps the signature key, so it continues the clean run.
Its real cost is therefore not a seed per refresh but this: each refresh moves the epoch, so every
sender's next send in that scope REDISTRIBUTES its seed - one extra frame per sender per refresh -
and a redistributed session takes the reused caps (50 messages, 24 hours FROM ITS MINT), so any
session already past a day ROTATES instead. With one refresh per active device per week, a
community whose devices refresh daily keeps every sender's session under a day old: the rotation
rate the departure-only rule was written to bring down returns through the caps. A key group's
leaves are refreshed by its own Adds and Removes meanwhile; what refreshing them would need (a
refresh that does not tighten the caps, or caps counted from the redistribution) is in
[backlog](../backlog.md).

### A joiner whose first frame beats its Welcome waits for it (DUP-2, 2026-10-25)

**The server is right to send it the frame, and the server-side fix was rejected for that reason.** A
commit that admits a device records its seat `pending` with `admittedAtEpoch`
(`ValidateCommitBody.admits`), and from then on the fan-out queues it every frame sealed at or after
that epoch ([chat-delivery](../services/chat-delivery.md)). Those frames are exactly the ones the
Welcome's epoch can open - a member's Remove at the Add's epoch is the next commit the joiner MUST
apply. "Do not fan a commit to a device whose Welcome the server has not seen" would therefore cut the
joiner off its own next epoch, or need a second queue the Welcome releases; the frame already waits
in the server queue, unacknowledged, which is that queue. When the adder's answer is lost, its
Welcome is owed state on the adder (above) and goes out only once the late resubmission settles; a
member committing in between reaches the joiner first.

**What the joiner does with it.** The frame names a group it holds no state for
(`handleUnknownGroup`): it is buffered, left unacknowledged in the server queue, and the one recovery
seam `requestReAdd` runs once to read the device's membership row. `[PIPELINE] Recovery attempt
finished for <g>` is that run settling - the line `startRecovery` writes whatever the seam decided.
Until DUP-2 the seam read "owed" (a Welcome queued, or a member holding the add lock) and then sent a
`welcome_request` anyway: every member was asked to do the Add's work again, the adder's lock turned
them away (`Lock busy`), and a member finding the lock free would have REPLACED the leaf the Add had
just written - a second commit and a second Welcome. Now the row is read as two facts
(`readWelcomeOwedFromRow`), and neither asks a member:

- `welcome-queued`: the Welcome is in this device's OWN mailbox, so the mailbox is pulled
  (`fetchPendingMessages`).
- `add-in-flight`: some member holds the group's add lock - per group, so not necessarily an Add of
  this device - and the device waits for it to settle.

A pending row that carries neither fact did not answer: every deployed server writes both since
2026-09-03, so it reads as unreadable (`null`), the pass is skipped and the line accuses. It used to
be a reading of its own, `pending-unqualified`, waited on as owed; nothing produced it, and it is
deleted. Only the leader tab pulls the mailbox for `welcome-queued`; a follower's pass returns.

The not-ready marker keeps the group on the sync watchdog's cadence, each pass re-reads the row, and
once no fact holds the reading is `unhonoured-seat` and the self-service join is the device's own
(`recovery.test.ts`, "the wait ENDS on the facts"). A seat from a link (`awaiting-admission`) still
asks a member: there, the ask IS the admission request. The Graine key-group join waits on the same
readings (`isWelcomeOwed`).

**A Welcome this device has just spent is not a Welcome on its way.** When a Welcome fails to install
(`NoMatchingKeyPackage`, `GroupAlreadyExists`), the handler starts the recovery before it returns
`true`, so before the drain acknowledges that Welcome: the row can still list it as queued. The
handler says so (`requestReAdd(..., { welcomeHandled: true })`) and the reading looks past the queued
Welcome, so the repair runs at once instead of waiting a cadence for the Welcome it just spent. The
log says the Welcome was read past, not that none was queued.

**It reads past EVERY queued Welcome of the group, and the guard is where the join acts, not in the
reading** (review of #2466). The row is a boolean: it cannot say whether the Welcome it lists is the
spent one or a second one a member sent with a fresh KeyPackage. Two orders are possible, and both
are safe:

- **The drain applies the second Welcome first.** The recovery reaches `externalJoin`, which reads the
  group again UNDER the MLS lock the Welcome took, finds it held, builds nothing and answers
  `{ joined: true, alreadyHeld: true }`; the recovery drops its bookkeeping and leaves the rest to
  the Welcome path. The engine refuses the same case by type before building
  (`MlsError::GroupAlreadyHeld`, `GROUP_ALREADY_HELD:`), and the TS side reads that refusal as joined
  and accuses the held-groups list that missed it. Before this, the "already present locally" guard
  sat AFTER OpenMLS's `ExternalCommitBuilder::finalize`, which had already written the built group
  into the live group's storage rows: memory kept the live group, the next save and load resurrected
  the external join's one, and the refusal read as `build_failed` asked a member to re-add a healthy
  leaf (`tests/external_join.rs`, `an_external_join_for_a_group_already_held_leaves_the_live_group_untouched`;
  `BaseMlsService.externalJoin.test.ts`, "stands down ... while it waited for the lock").
- **The external commit lands first.** It carries the same signature key as the leaf the second
  Welcome's Add wrote, and replaces that leaf in one commit (the admitted-seat case below); the late
  Welcome then meets a group already held and is ignored as a redelivery. If Welcome #2 is ignored
  (and ACKed) while our commit is built but not yet submitted, and the server then REJECTS that
  commit, the group is dropped (an external commit cannot be cleared) and the join retries from a
  fresh base, which already carries #2's leaf for our key: the next commit replaces it the same way,
  so the race converges on one leaf without the Welcome.

**Whichever way the group was already held, the recovery promotes the roster seat to `active` -
when `isGroupActive` proves our leaf is in the tree it holds.** The engine's typed refusal can be
reached with NO Welcome at all - the engine held the group and the service's list missed it (native,
after a PIN recovery) - and then nothing else ends the `pending` row, which every member is served as
a work item to Add a leaf already in the tree. The proof is the client's to carry: the server's
self-report (`POST mls/invitations/status` -> `activateDeviceMembership`, authority `report` ->
`promoteReportedSeat`) promotes any existing seat that is not kicked and whose owner is not awaiting
admission - in a key-distribution group, whose owner social-service answers is entitled
([state machine](mls-graine-state-machine.md#seat-writes-check-membership-2026-10-25)) - and cannot read the tree; an evicted group stays held, so holding is not the proof. After
a Welcome the promotion is a second write of the same value: the UPDATE matches the active row again,
logs one `[INVITATION_STATUS]` line and re-adds an existing Redis route, and emits no event. A refusal naming a DIFFERENT group than the one
asked for is not joined: the served base is unusable for this group and the join reads `build_failed`.

The other design - waiting for the spent Welcome's ACK before reading the row - was not taken: it
needs a per-delivery acknowledgement barrier through the drain, to buy what the lock already
guarantees at the one step that can do harm.

**When the Welcome lands, the buffer replays** and the frames left behind as `unknown-group` are
re-fetched. That re-fetch pulls every row the server still holds for the group, including a frame
live delivery read a moment earlier and has not acknowledged yet - a second read the client gives
itself, which is a defect of its own, open in
[backlog](../backlog.md#p3---a-re-fetch-after-a-late-welcome-re-reads-frames-the-live-socket-already-delivered-dup-2-2026-10-25).
What is fixed is what that second read was CALLED. MLS refuses it with `SecretReuseError`, which it
can only reach after opening the frame's sender data under this device's copy of the epoch - so the
frame is neither from a fork nor damaged. `messaging.rs` classifies it from the error's TYPE
(`is_spent_generation`) before the fork judgement: one `debug` line, no fork verdict, and the same
`SecretReuse` error to every caller, whose frame ledger then says `Duplicate delivery ... silent
ACK`. Until then it logged `[FORK] not a fork ... the frame itself is damaged` at WARN and a
same-epoch ERROR that `logging.rs` demoted by its marker; the demotion is deleted with the line it
hid. A frame whose bytes really are damaged keeps its WARN (`tests/spent_generation_is_not_damage.rs`).

**An admitted seat with neither fact joins by itself, and that is safe.** An Add the server accepted
whose adder holds no lock and has queued no Welcome leaves a seat with `admittedAtEpoch` (on the
`getDeviceMemberships` row, typed on `DeviceMembershipRow` and named in the recovery's line) that reads
`unhonoured-seat`. The external commit carries the same signature key as the leaf the Add wrote, and
OpenMLS removes that leaf in the same commit - one leaf for the key, the routine rejoin of an active
device (`tests/external_join.rs`, `an_admitted_joiner_joining_externally_leaves_exactly_one_leaf_for_its_key`).
Whether any adder path reaches that state, and what its late Welcome then meets, is a verification
in [backlog](../backlog.md#p3---verify-an-add-accepted-but-unannounced-lets-the-joiner-rejoin-over-its-own-leaf-dup-2-review-2026-10-25).

### An Add enrols its people with the accepted commit (2026-10-25)

**Found by the 1.4.1 dev campaign** (rows DUP-2, DUP-4, DUP-5, DUP-6, OFF-1, OFF-2, read from both
ends): the roster row of an invitee (`dm_group_members`) was written by the inviter's `registerMember`,
a separate call each Add path made AFTER it read the gate's accept. The settlement of an unresolved
commit (above) never made it. So an Add whose answer was lost - settled by a resubmission answered
`duplicate`, or held offline and sent on return, where the FIRST arrival was accepted and still nobody
enrolled - merged, sent its Welcome, and every copy was refused `welcome_target_not_member`. The
invitee held a leaf with no seat: its own repair (`[READD]` -> external join) found no membership row
and retired the conversation, and the inviter's next stray sweep took the leaf back out
(`removeStrayLeaves`, which was right to: the roster is the authority, and it did not name the person).

**The enrolment is part of the accepted commit** (`enrolAdmittedPeople`, `messaging.service.ts`): in
the transaction that advances the epoch and writes the log row, every person the commit `admits` a
device of and the roster does not name is enrolled through `ensureGroupMember` - the route's own
writer - BEFORE any device row, the one lock order of `utils/seat-eviction.ts`. Whichever request
lands - the first, a resubmission, an outbox replay - the advance and the seat commit together, and a
resubmission answered `duplicate` (answered before any transaction) finds exactly the state the first
accept left. Nothing for the client to remember, no pending-enrolment record, no clock. Judged
against PostgreSQL in `add-enrolment.integration.spec.ts`. **It is the ONLY writer of a new person
since ADM-3** - see "The commit is the one writer of a new person" below.

**Refused, and logged `NOT_ENROLLED reason=...`; ANY such refusal refuses the WHOLE commit**
(answered `200 {accepted: false, reason: 'admit_refused', userIds}` - `userIds` naming the refused
people, logged `REJECT admit_refused` - the shape `WelcomeSeatGone` already answers, so a client of
any version clears its staged commit on it): nothing advances, nobody gets a leaf, no device row is
written. A commit accepted with its admits dropped would still have given those people a leaf in
every member's tree - a leaf no seat holds - so the gate refuses it rather than accept it in part,
the reasoning `SEAT_CLAIM_OVERTAKEN` already follows. **Every candidate is decided before anything
is written**: a single refusal enrols nobody and logs no `ENROLLED` / `ADMITTED_UNDATED` line for the
rolled-back advance. The client rebuilds the Add WITHOUT the named people (`addDevicesRebuildingOnRace`, below):

- everyone not on the roster when the committer holds no admitted seat itself - answered with its
  own reason, `{accepted: false, reason: 'committer_not_on_roster'}` and no `userIds`: it is about
  the committer, not the people added, so nothing is rebuilt and nobody is reported removed;
- a person a block stands between and the committer (`blocked`);
- **a person who departed after the Add was DECIDED** (`departed_since_decision`, with
  `decidedBy=invitation|base_epoch`). A removal holds against an Add built before it (owner's rule,
  2026-10-14). A self-leave makes no
  commit, a member's Decline of an invitation-link ask makes none either, and a removal's Remove
  commit can be lost, so an Add held in an outbox can still land at the unchanged epoch after the
  departure; enrolling then would undo it. Ordered by a COUNTER, never a clock: every removal and
  every Decline moves the group's `seatGeneration` under the seat lock, a removal stamps it on the
  stretch it closes (`leftAtSeatGeneration`), a Decline - which DELETES the ask's stretch, since a
  closed one would read as a gap and withhold its span from every history answer - on the person's
  `dm_seat_evictions` row (`declinedAtSeatGeneration`), and every advance records the generation its
  epoch began at (`epochSeatGeneration`, migration 039). **An ask that EXPIRES records nothing:** no
  member decided anything, and a member's Add built while it was open is the answer it waited for -
  refusing it because a timer ran would let a clock decide an admission.

  **WHEN the Add was decided is carried by the client from where it is known** (ADM-3). A member's
  invitation reads its roster WITH the group's seat generation (`GET .../user-members?withSeatGeneration=1`,
  the generation read BEFORE the rows), records it in the commit's intent beside the roster baseline
  (`CommitInvitation.seatGeneration`, so a resubmission and a re-plan send the same value) and sends it
  as `invitationSeatGeneration` with an Add that admits somebody. The gate orders departures against
  it: one recorded after it holds against the Add, one recorded before it does not - so a deliberate
  re-invite after a Decline, at an unchanged epoch, is a fresh invite and enrols. A value the group
  never reached (above its current generation), negative or not an integer is a `400
  invitation_seat_generation_invalid`. An Add with no invitation (the automatic pending-row and
  welcome-request Adds, an old client) has none, and is ordered by the base epoch's generation
  (`decidedBy=base_epoch`): **the one-sided cost accepted by the owner on 2026-10-25 now falls only on
  those** - a re-invite by a client older than this change, right after a Decline in a quiet group,
  is refused until the next commit moves the epoch.

- **a person whose seat still AWAITS a member's answer, against the same order** - checked like a
  newcomer (blocks, the committer's seat, a departure recorded after the decision): a new ask after
  a Decline is not answered by an Add decided before that Decline. An awaiting
  seat the gate admits is lifted by the caller (`liftAwaitingAdmission`); one it refuses stays an
  ask, unanswered.
- **an awaiting seat of a person who EVER departed - removed, left, or declined by a member - by an
  Add with no invitation generation** (`departed_and_undated`). Once another commit moved the epoch,
  the base epoch alone cannot order such an Add against the departure, so only a member's invitation
  - which carries when it was decided - admits that person again. And an awaiting seat admitted on the base epoch's order alone is logged at WARN
  (`ADMITTED_UNDATED ... decidedBy=base_epoch`), so how often an undated Add answers an ask is
  measured, not assumed.

**The client rebuilds, and never loops.** `refusedAdmits` reads the typed `CommitRefusedError`
(reason `admit_refused` and its `userIds`), never the message; both reasons are not rebuildable as a
race (`rebuildableRefusal`), since the same commit meets the same answer at any epoch. `addDevicesRebuildingOnRace` drops the named people's candidates and their names from the
invitation it carries, re-checks the premise without them, and stages again; each such pass drops at
least one candidate, a refusal naming none of them leaves as thrown, and with nobody left the Add is
abandoned (`not-admitted`, reported `removed-meanwhile`). A one-device Add - the pending-row sweep,
the welcome-request answer - has nobody to rebuild without: it logs and stops, the row stays as the
server holds it. A kept commit settled `admit_refused` (read off the answer's body) is re-planned
for the other invited people as after a race, and is `refused` (the member told) when it named
nobody else. A 1:1 creation whose peer is refused is abandoned at once (`mustAdmit`), before anything
is staged again, and is not created.

**A seat still awaiting a member is always an ask.** The pending-row sweep and the welcome-request
answer never make an automatic Add for a person whose seat `awaitingAdmission`, whatever the local
tree holds: they ask a member (`onJoinApprovalRequested`), and only that member's gesture answers.
The Android background route `send-welcome-and-commit` goes through the same gate; its only admit is
the Welcome target, so a refusal there is the `WelcomeSeatGone` answer.

A seat already on the roster AND admitted is left as it is. A refused Welcome target refuses the
whole commit that carries it inline (`WelcomeSeatGone`): the background native Add has no other way
to learn. A key group has no conversation roster: its people are social-service's entitlement, asked
before the advance (`claimKeyGroupAdmits`), and nothing here applies to it.

### The commit is the one writer of a new person (ADM-3, 2026-10-25)

Two writers used to decide whether a person is in: the commit's gate, which reads the seat lock and
the departures, and the member-add route, which read neither - so a Decline the gate honoured could
be undone by the route the same second. Now the accepted commit is the one writer.

**Every writer that enrols or admits a person, and what it does now:**

| Writer | Since ADM-3 |
| --- | --- |
| The accepted commit (`enrolAdmittedPeople` + `liftAwaitingAdmission`) | The ONLY one. Newcomers and awaiting seats, ordered against the invitation's generation, under the seat lock. |
| `POST mls/groups/:id/members` (`addGroupMember`) | Enrols nobody but the caller, into an empty roster (the bootstrap). For anyone else it re-reads the seat under the seat lock (`writePendingSeats`, `requireAdmitted`): admitted -> writes their device rows, a no-op for the roster; absent or awaiting -> `409 MEMBER_NOT_ADMITTED`, nothing written. |
| A Welcome sent apart (`sendWelcome`) | Admits nobody; refused for an awaiting seat. |
| An inline Welcome in a commit | Admitted only if the commit's gate admits its target; otherwise the commit is refused. |
| Link acceptance (`writePendingSeats`, `enrol`) | Writes an ASK, never an admission. After a Decline it may write a new one: a Decline is not a ban. |
| `registerDevice` (`writePendingSeats`, no enrol) | Only for a person already on the roster. |
| `withdrawAwaitingSeat`, `expireUnansweredAsks` | Remove, never admit. |

**The client keeps calling the route after an accepted Add**, because a server older than this
change still enrols through it ([legacy-compatibility](../legacy-compatibility.md#no-date-yet---registermember-after-an-accepted-add-for-a-server-older-than-2026-10-25)).
It is typed now: since the gate refuses a commit naming anyone it may not admit, an accepted commit
enrolled everyone it named, and `MemberNotAdmittedError` after it means the person departed since
the merge. The client then sends them NO Welcome and does not report them added - every Add path:
the invitation (`processBulkAddition`), the pending-row Add and the welcome-request Add
(`actions.ts`), and a 1:1 creation, which is dropped. The departure's own Remove takes their leaf, or
the stray collector, which reads a seat still awaiting a member as off the roster (`awaiting` in
`POST mls/group-rosters`, `awaitingAdmission` on the fresh read).

**A leaf is not an admission.** A member answering an ask (`admitJoinRequest`) whose tree already
holds a leaf of the person reads the seat before claiming another member's Add admitted them: an
admitted seat is done, one still awaiting (or gone) has its leaf removed by the stray collector first
and is then admitted by the member's own Add.

**A refused Welcome is no longer owed for ever.** `POST /api/mls/welcome` answers a target off the
roster `403 WELCOME_TARGET_NOT_MEMBER` (the `error` field kept for older clients), typed client-side
as `WelcomeTargetNotMemberError`. That refusal cannot change by resending: the target departed, a
block stands, the committer held no seat, or the commit was accepted by a server that did not enrol.
So `deliverOwedWelcomes` clears that recipient at `console.error` and keeps every other failure owed;
until then a settlement re-sent the refused bytes at every connection.

**And the leaf such a refused person holds is the stray sweep's.** The sweep reads the tree first and
the roster after, and an accepted Add's person is enrolled in the advance unless refused above - so
the leaves it finds without a seat are exactly the refused ones, which it is right to remove. It
REMOVES them and repairs nothing: a person refused here needs a new Add to be in. What the
older shape still leaves is in
[legacy-compatibility](../legacy-compatibility.md#no-date-yet---registermember-after-an-accepted-add-for-a-server-older-than-2026-10-25).

### A revoked device's leaf is removed from every conversation

Revoking a device (`DELETE mls/devices/:userId/:deviceId`) writes a `revoked_device` row and purges
routing; it cannot touch a tree. The roster batch (`POST /api/mls/group-rosters`) now also answers,
per answered group, the ACTIVE revocations of the people on that roster (`revoked`, as
`userId:deviceId`). `removeStrayLeaves` (`frontend/src/lib/utils/chat/strayLeaves.ts`) removes a leaf
whose whole identity is in that list, by device (`removeMemberDevice`), after the departures and on a
fresh tree and a fresh answer. It is an ALLOWLIST: a leaf the routing table merely forgot is never a
candidate, and a device never removes its own leaf. Like the refresh, nobody asked for this commit,
so it is staged only on the published branch (`assertOnPublishedBranch` above; a refusal is logged
`[STRAY] ... NOT removed` and nothing is staged). Key groups are not covered yet: their roster
collector (`reconcileDistributionGroupRoster`) does not read the `revoked` answer, a separate
question from the refresh's cost ([backlog](../backlog.md)).

**And the revoked device cannot commit** (2026-10-23). The commit gate (`validateCommit`) refuses a
commit from a device under an active revocation - `403 DEVICE_REVOKED`, FIRST: before the ownership
check, the lock and the duplicate answer, read by the pair on the denylist's existing
`(userId, deviceId)` unique index ([chat-delivery](../services/chat-delivery.md)). The revocation
purges the static KeyPackage, so an ownership check asked first answers `device_not_owned` - true by
coincidence, and not the answer the device's client acts on.

### Static fallback key package

- Generated on every `generateKeyPackage()` call, and published before the pool.
- Stored server-side as the device's main KP.
- Used when all OTKPs are exhausted - which the server now says out loud (`[KP] one-time pool
  EMPTY`), because a client that has stopped replenishing is invisible from anywhere else.

### One-time key packages (OTKP / prekeys)

- Pool of 50 (web) / 200 (Tauri) replenished on connect. Target: 20, threshold: 5.
- Atomically consumed by inviting devices.
- On fresh start: old OTKPs have no matching private keys -> purged via `DELETE /api/mls/devices/:userId/:deviceId/prekeys` **before** generating new ones. `freshStart` is `!state`, so this is a NEW INSTALL and not a launch - it is not what accumulated the bundles measured below.
- Every bundle a device mints stays in its local keystore until its 84-day lifetime elapses; see the section below for what one weighs and what bounds the pile.

### What a key package WEIGHS, and the prune that bounds it

Minting one writes its private bundle into the provider's storage, and until 2026-09-06 nothing ever
deleted one. `frontend/mls-core/tests/state_weight.rs` is the measurement - IGNORED by default,
because a number is not a pass or a fail and pinning today's bytes would only manufacture a failure
the first time a legitimate field is added:

```
cargo test --release --test state_weight -- --ignored --nocapture
```

| what | bytes | how it was read |
|---|---|---|
| one-time prekey bundle | **1 936** | four rounds of 50, slope |
| a group of one | 5 330 | four rounds of 10 - a FLOOR, no members, no history |
| one member added to a group | ~2 000 | four rounds of 5, each from its OWN device |
| **50 sends** | **~0** | flat after the first batch |

Two things follow, and both were assumptions before. **Sends are flat, so message history is not
what makes a blob heavy** - a device that has simply been used for months does not explain itself.
And in a state holding 41 groups AND 200 prekeys, the prekeys are **60.1%** of it. The docblocks in
`TauriMlsService` and `WebMlsService` that justify a pool of 50 said "each ~400 bytes"; they were
wrong by five times, which is what made "hundreds of unused bundles" sound affordable.

**The asymmetry that leaked.** `reconcilePublishedKeyPackages` purges the SERVER of a prekey whose
private key is gone locally. Nothing asked the opposite question, so a bundle the server had stopped
publishing was kept for ever, and two callers mint without bound: `generateKeyPackageImpl` publishes
a fresh last-resort package on **every connection**, and `republishKeyMaterial` purges the pool and
mints up to 50 more **once per 30 s** through a `NoMatchingKeyPackage` storm - ~97 kB orphaned each
round. The Mi 9T came out of the 2026-09 healing campaign with a 19 548 753-byte `mls.bin`, ~200
such rounds, a 17-second checkpoint and a 22-second unlock.

**`MlsManager::prune_expired_key_packages` deletes every stored bundle whose lifetime has elapsed,
once per load.** It hangs off `load_or_create`, and `load_with_key` delegates there, so the web
client, the native client and the background FCM path all shed through one seam - no timer, no
second path. A failure is logged and does not fail the load: a device that cannot shed still works,
one that refuses to load has lost everything.

**Why expiry, and not "the server no longer publishes it".** The delivery service DELETES a one-time
prekey as it hands it out, so absence from the server is exactly what a bundle looks like when a peer
is about to send the Welcome built on it - pruning on that signal would race a join and lose it. An
elapsed `not_after` has no such ambiguity: openmls defaults it to 84 days, and a Welcome referencing
an expired KeyPackage is invalid under RFC 9420. The delete is confined to what could not have been
used anyway, needs no server round-trip and races nothing. The clock is a PARAMETER
(`prune_key_packages_expired_at`) so `tests/prune_expired_key_packages.rs` can ask what the state
looks like in a hundred days without asserting on a wall clock.

**The prefix is an optimisation; the identity check is the safety property.** The scan first matched
`b"KeyPackage"` and decoded - and replacing that prefix with `b""`, matching every entry in the
state, left all four tests green, including the one asserting groups survive. The real refusal was
`serde_json` failing to decode group state as a `KeyPackageBundle`, which is luck: serde ignores
unknown fields. Each candidate now recomputes its own `hash_ref` and must be named by the key it is
stored under - exact by construction, since `openmls_memory_storage` builds every key as
`label || json(id) || version`.

**WHAT A REAL DEVICE'S STATE IS MADE OF, READ OFF THE PHONE RATHER THAN INFERRED** (Mi 9T,
2026-09-06, one line at load from `MlsManager::state_composition`):

| part | entries | bytes | share | each |
| --- | --- | --- | --- | --- |
| **KeyPackage** | **2 338** | **5 523 276** | **69%** | 2 362 |
| MessageSecrets | 5 | 1 220 171 | 15% | 244 034 |
| Tree | 5 | 1 208 632 | 15% | 241 726 |

**Accumulated key package bundles are two thirds of it** - 2 338 of them on a device whose server
pool holds fifty. **None had expired**, because the pile accumulates in weeks and openmls dates a
key package 84 days ahead: the prune bounds the ceiling but its horizon never arrives at this mint
rate, which is why a tighter or count-based retention is still owed ([backlog](../backlog.md)).

**A REAL GROUP IS ~490 kB, AND NOT FOR THE REASON THAT LOOKED OBVIOUS.** The weight is `Tree` - the
member leaves a long-lived group accumulates, ~242 kB being roughly 120 of them - and
`MessageSecrets`, the per-sender ratchet history that `SenderRatchetConfiguration::new(2000, 2000)`
sizes on purpose. It is NOT epochs:

**WHAT IS BOUNDED AND WHAT IS NOT, MEASURED RATHER THAN DIVIDED.** `what_an_epoch_costs_at_constant_membership`
churns one device in and out of a group forty times: at **81 epochs the state PLATEAUS at 17 364
bytes**, growth stopping after the second round, with `MessageSecrets` and `ResumptionPsk` holding
ONE entry each. **Accumulated epochs are therefore NOT what makes a long-lived group heavy** - the
obvious suspect, eliminated. The field number that prompted it: sweeping 42 abandoned groups off a
Mi 9T took `mls.bin` from 20 812 360 to 8 018 495 bytes and a checkpoint from 48 449 ms to 6 943 ms.
What remains expensive about a real group is not yet named, and
`MlsManager::state_composition` exists so the next occurrence is read off the device rather than
inferred - which is how the same question got two wrong answers in one evening.

**What this does NOT do.** It bounds growth at (mint rate x 84 days) and does not shrink a blob whose
bundles are younger. Two accrual paths remain open in [backlog](../backlog.md): reusing a still-valid
last-resort package instead of minting one per connection, and `republishKeyMaterial`'s 50 orphans.
**The obvious fix for the second is wrong** - dropping the local bundles when the server pool is
purged races a peer that claimed one seconds earlier with the Welcome still in flight. The
discriminator exists only on the server: a claim and the row's deletion are atomic, so anything still
present when `DELETE .../prekeys` runs is provably unclaimed. The endpoint returning the ids it
deleted would let the client drop exactly those, with no race and no clock.

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
read by a build older than that commit (`01bc0a13`, WP-ANR-1).** The frontend must not be rolled back past it, or every
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

`loadStateWithKey` rejects with a TYPED `mls-core` error, and `BaseMlsService.classifyStateLoadFailure`
reads the type, never a sentence (table below). One case is checked first because it looks exactly
like `undecryptable` and has a completely different answer.

### An envelope older than v0.11.0

Before v0.11.0 the snapshot was sealed `[salt (16) || nonce (12) || ciphertext]` with
Argon2id(PIN, salt). v0.11.x seals `[nonce (12) || ciphertext]` with the PBKDF2 device key, and
shipped no reader for the old envelope - while `CanariDBMls_<userId>` stayed pinned at schema
version 1 and native `mls.bin` carries no version either. Nothing rewrote or dropped those blobs,
so on the first v0.11.x login they fail to decrypt and are indistinguishable from a key rotated
elsewhere. Reported as such, they sent every upgrading user into an old-PIN recovery that could
never succeed.

So on an `undecryptable` verdict, when the caller supplied `MlsInitOptions.legacyPin` (the PIN just
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
be rejected - with a `mismatch`, not an `undecryptable`. The verdict is therefore re-read from the
migration's own failure and applied by the normal path below. Doing this from inside the first
`catch` is what let a raw `Credential identity mismatch` escape `init` instead of fresh-starting.

### The `classifyStateLoadFailure` verdicts

| Verdict | Thrown as | Meaning | Recovery |
|---|---|---|---|
| `undecryptable` | `STATE_UNDECRYPTABLE:` | The AEAD tag did not verify. An OBSERVATION with two causes the legacy blob cannot separate: sealed under another device key (a PIN rotated elsewhere) or ALTERED (corruption, an interrupted flush). | Honour `MlsInitOptions.noFreshStart`: throw `SavedStateUnopenedError('undecryptable')`; the gate (`auth_local_state_unopenable`) names BOTH causes, offers the old PIN and names the reset. |
| `rotated` | `STATE_KEY_MISMATCH:` | A FRAMED blob's header names a key other than the one in hand - checked before the cipher. | `SavedStateUnopenedError('rotated')`; the gate (`auth_local_state_old_pin`) states it as a fact. The pre-v0.11.0 Argon2id retry must NOT fire. |
| `altered` | `STATE_ALTERED:` | A FRAMED blob's header names THE KEY IN HAND and the tag fails: the bytes were altered. | Rotate, like `mismatch`: no PIN ever opens it, so `noFreshStart` does NOT apply (DE7). |
| `mismatch` | `IDENTITY_MISMATCH:` | The blob decrypted; its credential names another device (localStorage cleared, reinstall, or an interrupted fresh start). | Fresh start. `noFreshStart` does NOT apply - no PIN can repair an identity, so pausing would strand the user. |
| `keystore_unavailable` | `KEYSTORE_KEY_UNAVAILABLE` | The native keystore holds no key (a refused fingerprint). | The PIN modal. |
| `unknown` | anything else | Not typed by `mls-core`. | WARNs, and pauses rather than rotating: the blocking test is `!noPinOpensState(cause)`. |

**It used to branch on prose, with a default arm of `sealed`** - so every unrecognised failure,
corruption included, told the user *"your PIN was changed on another device"*. Measured by CORRUPT-2
and CORRUPT-1 on 2026-09-08 (one flipped byte; the state cut to half its length): the message sent
the user after an old PIN that never existed, and the correct PIN left the gate `LOCKED+overlay` five
passes running. Typed in `v0.18.18`; `state_load_failure_is_typed.rs` and the classifier tests
assert that the OLD PROSE no longer classifies. **Since step 2 (PK1, 2026-10-17) a damaged FRAMED
state exits by itself** (`altered` rotates); a damaged LEGACY blob still exits only through
`onForgotPinReset` until its first rewrite, since its bytes cannot say it was altered.

### The state blob's framing - read-first, write-later

`mls-core/src/state_blob.rs` is the one place either platform decides what shape a state blob is:

```
legacy : [nonce (12) || ciphertext]                                  <- written before step 2
v1     : [b"CANARIS" || 1 || key_fingerprint (8) || nonce || ct]     <- every save since step 2
v2     : [b"CANARIS" || 2 || key_fingerprint (8) || iv (12) || AES-256-GCM ct || tag (16)]
                                                                     <- the WEB writer, switched off
```

The fingerprint is what turns `undecryptable` into two verdicts: a header naming the key in hand
excludes rotation, so a failed tag is alteration; a header naming another key is `rotated`. Seven
magic bytes plus a version byte make "is this framed" a 2^-64 question, so there is no
re-parse-as-legacy retry (it would be a fallback). The fingerprint is eight bytes of SHA-256 over a
domain constant and the key - NOT the AEAD under a fixed nonce, which would risk reusing a nonce on a
public plaintext. The two readers (`load_with_key`, the keystore probe in `resolve_at_rest_key`)
share it; the probe on its own would have read a header as a nonce and DELETED a good keystore key.
(A third, `mls-wasm`'s `decrypt_mls_state_blob_with_key`, had no caller and was deleted 2026-10-12.)

**The header goes at the STATE layer, never in `security::encrypt_blob`**, which also seals the
PIN-protected backup files. **The writer cannot move first**: an older build handed a framed blob
reads the magic as a nonce and reports the state unopenable - this very defect, caused by a
downgrade. So the reader shipped first (`v0.18.18`, behaviourally inert), and the writer flipped
once `minClientVersion` (`1.0.3`) made that reader the floor everywhere: **step 2 (PK1, 2026-10-17)**
- `encrypt_state_blob_with_key`, the one native and WASM writer, calls `frame_v1`
([backlog](../backlog.md#p1---a-damaged-local-mls-state-is-reported-as-a-pin-rotation-and-the-pin-the-user-actually-holds-does-not-get-them-back-in-measured-2026-09-08)).
**Never roll a client back past `v0.18.18`.**

**What each verdict does at `init`** (both platforms, `noFreshStart` set):

| `mls-core` code | `StateLoadFailure` | `init` | the gate |
| --- | --- | --- | --- |
| `STATE_KEY_MISMATCH` | `rotated` | pauses, `SavedStateUnopenedError('rotated')` | `local_state_sealed_under_old_pin`: the old PIN opens it, said as a fact |
| `STATE_ALTERED` | `altered` | ROTATES the device identity - no PIN ever opens it (DE7) | none: the session starts |
| `STATE_UNDECRYPTABLE` (legacy blob, stub) | `undecryptable` | pauses, `SavedStateUnopenedError('undecryptable')` | `local_state_unopenable`: both remedies named |
| `IDENTITY_MISMATCH` | `mismatch` | rotates, as before | none |

**On a phone, an owner record comes first.** `mls.bin` is one file per install, so `initialiser_mls`
writes `mls.owner` (the account id) each time a state OPENS, and a state reset
(`terminer_session_mls` with `sweepState`) removes both. When a load fails and the record names
ANOTHER account, `TauriMlsService._initImpl` throws `SavedStateOfAnotherAccountError` before any
branch above runs - nothing re-sealed, rotated or written - and the gate
(`device_holds_other_account`) withholds the reset that would delete that account's state. No record
is absence of proof and changes nothing. The browser keeps one state per account and has no record.

#### The native manager does not outlive its account (2026-10-27)

On a phone the manager is process-wide (`AppState.mls_manager`, with its cached at-rest key
`device_key`), and a sign-out is an in-app navigation, not a restart. Until 2026-10-27 the slot was
only ever written `Some`: account A's manager and key stayed installed into account B's session, and a
FAILED `initialiser_mls` of B left them in place. The guarantee now:

- **One teardown, one hold.** `end_native_session` (`concurrency.rs`) takes
  `foreground_checkpoint_lock`, then the manager mutex (the device-key mutex inside it), then
  `mls_bin_write_lock`, and under that one hold empties the slot, clears the key, clears the
  warm-process mark (`live_manager_in_process`) and - for a reset - sweeps `mls.bin` and every file
  built from it (`remove_mls_state_held`). Poisoned locks are taken anyway: a teardown that refused
  would leave the previous manager installed. The manager is dropped after the locks are released, and
  nothing under the hold calls into the JVM or the WebView.
- **One command, one helper.** `terminer_session_mls { reason, sweepState }` is the command, and
  `endNativeMlsSession` (`lib/utils/nativeMlsSession.ts`) the only caller: the MLS holder's retirement
  (sign-out, account switch - after the final checkpoint, since it needs the manager) and reset (a
  stopped or failed login, a revoked device), both inside `whenRetired`, which the next login awaits;
  a failed `initialiser_mls`; `removeMlsState` and the factory wipe (with the sweep). `clear_app_data`
  also ends it natively before it wipes. A sign-out keeps `mls.bin` for the account's next sign-in.
- **A failed install leaves the slot empty by construction.** `initialiser_mls` creates an install
  guard before its first fallible step; every exit that does not reach the install (an `Err`, a panic)
  runs the teardown when the guard drops.
- **An absent manager is a typed refusal.** Every MLS command reads the slot through
  `live_manager` / `live_manager_mut` (`state.rs`) and answers `MLS_MANAGER_ABSENT`, read on the
  TypeScript side by `isMlsManagerAbsent` - never the sentence. A command waiting on the manager mutex
  during a teardown gets that code once it is released; it never acts on the previous manager and never
  waits for a new one. A resume reload into an empty slot is refused the same way: it refreshes a live
  manager and never installs one.

The browser has no process-wide manager: the WASM client is a field of each `WebMlsService` instance,
which the holder drops with its account, and the WASM module itself holds no manager or key.

#### v2 - the browser seals with WebCrypto, every platform reads it (2026-10-12)

**Why.** On a 7.7 MB state the WASM ChaCha20-Poly1305 seal was 82 % of a web checkpoint (141 of
175 ms, desktop Chrome): `chacha20` has no SIMD backend on `wasm32`. WebCrypto AES-GCM runs on
hardware AES ([performance-audit](../frontend/performance-audit-2026-10-12.md#the-webcrypto-seal-v2---measured-2026-10-12)
has the before/after table).

**The decisions, each with its reason:**

- **The fingerprint is the DEVICE key's**, the v1 function unchanged, so "sealed under another key"
  is read from the header in both versions and `classifyStateLoadFailure` needs nothing new.
- **The AES key is HKDF-SHA256(device key, `V2_KDF_SALT`, `V2_KDF_INFO`)**, never the device key: that
  key already keys ChaCha20-Poly1305 for every legacy blob, and one raw key under two AEADs is a
  question nobody has to answer if it never happens. Derived once per device key on the web, as a
  non-extractable `CryptoKey`.
- **The 16 header bytes are the AAD**, so a rewritten version or fingerprint fails the tag instead of
  steering the reader somewhere plausible. **They are ALL the AAD binds**: nothing about whose state
  it is, or how recent. A blob swapped for another sealed under the same device key therefore OPENS;
  what refuses to install it is the identity check after the open (`IDENTITY_MISMATCH`, the
  credential must name this `user:device`). An older checkpoint of the SAME identity put back is not
  detected by the seal at all - the same as v1 and legacy.
- **The writer is TypeScript only** (`mlsStateSeal.ts`, routed by `sealWebMlsState` in
  `mlsEncryptWorkerSession.ts`, which THROWS inside Tauri). `mls-core` has no v2 writer, so a native
  build cannot produce one by construction.
- **`mls-core` reads v2 on EVERY target**, because a web blob reaches a phone: a `.canari` backup
  carries the stored state as-is (`exportMlsStateAsHex` -> `saveMlsState`).
- **But in the browser, v2 is opened by WebCrypto** (`openMlsStateBlobV2`, dispatched in
  `loadAndInitWasm`) and the WASM gets plain CBOR. Measured, not chosen: the WASM reader's software
  AES opened 7.7 MB in 610 ms against 240 ms for ChaCha - a cold-start regression that would have
  eaten the checkpoint saving. Every OTHER shape still goes to `mls-core` sealed. The two v2 readers
  open the same committed fixture and throw the same codes for what the BYTES decide
  (`STATE_KEY_MISMATCH` before the cipher, `STATE_UNDECRYPTABLE` for a stub), which is what keeps them
  from drifting.
- **A WebCrypto refusal is NOT `STATE_ALTERED` (review of #2074, 2026-10-18).** WebKit names an
  engine fault (memory pressure on a ~19 MB state) and a failed tag with the same `OperationError`, and
  `altered` makes `init` rotate the device identity even under `noFreshStart` - irreversibly. So the
  web opener throws `MlsStateUnreadableNowError` (blob size, error name, whether the key derivation
  succeeded), and `loadAndInitWasm` asks `mls-core`'s deterministic reader for the verdict through
  `state_blob_verdict` (`mls-wasm`). **The verdict crosses the boundary as a CODE, classified on the
  Rust variant** (`MlsError::state_verdict_code`), never by matching the text of a thrown message:
  `OPENED`, or one of `STATE_ALTERED`, `STATE_KEY_MISMATCH`, `STATE_UNDECRYPTABLE`,
  `IDENTITY_MISMATCH`, which returns as the typed `MlsStateVerdictError` that
  `classifyStateLoadFailure` reads by type - so `altered` is only ever its proof and the old-PIN
  recovery stays reachable. Each code is also the `Display` prefix the Tauri commands surface, so
  both boundaries use the same word (pinned in `state_load_failure_is_typed.rs`). A REJECTION from
  `state_blob_verdict` is by contract no verdict, whatever its text. If the reader OPENS the bytes,
  the engine fault is proven; what it loaded is dropped inside the call, never installed (a witness,
  not a second load path), and a re-read of the same bytes does not ask again; a rejection (a trap)
  drops the memoised WASM instance. Anything but a verdict stays `unreadable_now`:
  `WebMlsService.loadStateWithKey` reads the state up to `MLS_STATE_UNREADABLE_NOW_READS` (3) times,
  then `init` throws `SavedStateUnopenedError('unreadable_now')` with or without `noFreshStart` -
  nothing rotated or written, the login shows `auth_local_state_unreadable_now`
  (`local_state_unreadable_now`, in no recovery predicate), the next start reads again. The PIN
  recovery says the same (`LocalStateUnreadableNowError` in `pinChange.ts`), never the "damaged,
  reset" sentence of `LocalStateUnopenableError`. Pinned by `WebMlsService.unreadableNow.test.ts`,
  `mlsWasmLoader.test.ts` and, on the REAL WASM, `mlsStateSeal.realWasm.test.ts`.
- **`unreadable_now` HAS NO EXIT IN CODE, AND THAT IS DECIDED, NOT FORGOTTEN.** A browser that
  refuses the same bytes on every start lands on the same message on every start. Nothing repairs it
  silently: installing the state `mls-core` opened would be a second load path behind a failed
  primary one, and rotating is the irreversible loss this branch exists to refuse. **The remedy is
  the user's, and the message names it**: free memory (Canari's other tabs, heavy tabs and apps),
  restart the browser and sign in again; meanwhile use the app or another browser, which are other
  devices and leave this one's state intact; ask support before any reset, which would erase it. The
  persistent case - what, if anything, the product offers after N starts - is an owed item
  ([backlog](../backlog.md#p2---unreadable-right-now-on-every-start-has-no-exit-but-the-user)).
- **The seal runs on the calling thread, not the encrypt worker**: WebCrypto already runs the cipher
  off the JavaScript thread; what remains on it is the input copy, measured as the main thread's
  longest stall.
- **IV: 96 random bits per seal.** The random-IV GCM bound (~2^32 seals per key) is 136 years at one
  checkpoint per second.

**Downgrade story.** A build with the v1 reader (`>= v0.18.18`) refuses version 2 by name
("written by a newer client, so this is a downgrade"); an older one reads `CANARIS\x02` as a nonce
and fails the ChaCha tag. Both are `STATE_UNDECRYPTABLE`: loud, nothing destroyed, the user asked for
the PIN - and holding a state that build cannot open. That is why **the writer ships OFF**,
read-first like v1. Two paths hand a v2 blob to an older web bundle: a tab still running the previous
bundle that re-reads IndexedDB (an unlock after a deploy), and a web deploy rolled back.

**A v2 reader is not enough: the HARDENED one is, so the writer is still OFF.** A v2 reader is in
every build since `v1.2.7` (#1793), but the builds before the hardening above turn a v2 blob that
WebCrypto refuses into a wrong answer: `v1.2.7` into `STATE_UNDECRYPTABLE` (the PIN-recovery prompt,
for a state no PIN opens there), and `v1.4.0` into `STATE_ALTERED`, after which
`noPinOpensState('altered')` ROTATES the identity, irreversibly - for bytes that may have been
healthy and only met an engine fault. A v2 blob reaching such a build (an old tab re-initialising, or
a web rollback down to one) is the backlog's "a damaged MLS state is called a PIN rotation" again. So
the release carrying the hardened reader ships with `MLS_STATE_SEAL_V2_WRITER_ENABLED = false`, and
**the flip is its own later pull request, owed once BOTH floors are at or past the release tag that
carries this reader**: production's `minClientVersion`, AND the lowest tag a web rollback is still
allowed to reach. A tag, never a date ([durable-rules](../durable-rules.md)). Owed in
[backlog](../backlog.md#p2---the-web-checkpoint-is-82--wasm-chacha20-seal---built-writer-off-draft-pr-2026-10-12).

**Every reader, enumerated on `main` (2026-10-18), for the flip to rely on:** the web load
(`loadAndInitWasm` -> `openMlsStateBlobV2`) is the ONE entry of the init, the PIN-recovery open
(`openLocalStateWithKey` -> `loadStateWithKey`) and the reload after a key-package round; every
native load (Tauri commands, `concurrency.rs`, the Android background JNI, the iOS NSE, the
`.canari` restore probe in `storage.rs`, the other-account check) goes through
`MlsManager::load_with_key` / `state_blob::parse`, which reads v2. Nothing else in the frontend reads
the blob's bytes. Native builds never WRITE v2 (`sealWebMlsState` throws inside Tauri), so on a phone
the flip changes only the phone's BROWSER.

**Once flipped, it is a one-way door for the DATA, never for the code.** Setting the constant back to
`false` stops new v2 writes and nothing else: a v2 blob stays v2 until its next checkpoint rewrites
it legacy. So from the flip on **both v2 readers are permanent**, and the web rollback floor can
never again go below the tag carrying the hardened reader. `mlsStateSeal.test.ts` already fails if
the web dispatch or `mls-core`'s `open_v2` leaves the tree, and asserts the writer OFF - the flip PR
moves that assertion. The encrypt worker and `encryptMlsStateOnMainThread` keep their legacy caller
until the flip has shipped in a stable, so a revert stays one line; they are deleted after.

**Pinned by** `mls-core/tests/state_blob_v2.rs` (the TypeScript writer's own bytes, frozen in
`tests/fixtures/webcrypto-v2-peer-state.bin` by `frontend/scripts/freeze-v2-state-blob-fixture.ts`,
must LOAD; every bit-flip region, truncation, wrong key, forged fingerprint and rewritten version
fails as the right variant) and `mlsStateSeal.test.ts`; both assert the same known-answer fingerprint
and derived key. **The known residue, pinned rather than hidden**: a corrupted FINGERPRINT byte reads
as `rotated`, because the fingerprint is consulted before the tag - eight bytes of a multi-megabyte
blob, the same in v1, and the recovery it leads to destroys nothing.

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

`initTabLeadershipAsync()` elects a single leader tab. Only the leader opens the WebSocket and runs
`discoverMissingGroups`; followers skip `initializeConnection()` entirely, because both tabs load
their MLS client from ONE snapshot and a send from the tab whose ratchet is behind is encrypted at a
generation the peer has already consumed, then dropped silently (WP-MULTITAB-1).

**The Web Locks API is the path every real browser takes**: one exclusive `canari-tab-leader` lock,
held until `beforeunload`, with mutual exclusion guaranteed by the browser rather than by a
read-modify-write on `localStorage`. The `BroadcastChannel` + heartbeat implementation is the
fallback for engines without `navigator.locks` (Tauri WebKitGTK, very old browsers), and
`canari-mls-tab` still carries the takeover and promotion messages on both paths.

### A tab queued behind itself and went read-only for ever - FIXED 2026-09-21

**MEASURED ON W2 ON THE RUNNING PRODUCT.** `navigator.locks.query()` answered `canari-tab-leader`
**held** by client `BCDAE226...` and **pending** for client `BCDAE226...` - the same client id on
both sides, in a browser profile with exactly one page. A Web Locks `clientId` names a document, so
that document was waiting for a lock it already held, and the only thing that releases that hold is
its own `beforeunload`. On screen: *"Messagerie chiffree active dans un autre onglet"*, a
*Hors-ligne* header, and not one community ever listed - permanently, with no other tab in
existence.

**"Prendre la main" cannot rescue it**, and that is the same defect seen from the other end rather
than a second one: `requestLeadershipTakeover` posts `request_takeover` on a `BroadcastChannel`,
and **a BroadcastChannel never delivers to the context that posted**. The only tab that could
release the lock is the one asking for it.

**HOW ONE DOCUMENT REQUESTS TWICE.** `initTabLeadershipAsync` has a single production caller -
`sessionAuth.ts`'s login - and a login runs more than once in a page's life: a PIN refused, a
reset, a new PIN is two of them, which is exactly the sequence that produced this. Run 1 takes the
lock with `ifAvailable` and holds it; run 2 probes, is told `null` **by its own hold**, calls
`decide('follower')` over run 1's answer, and queues a blocking request that can only be granted
by the release it is itself blocking.

**THE FIX IS THAT THE ELECTION IS A PROPERTY OF THE DOCUMENT, NOT OF A LOGIN.** The promise is
memoised: the first call runs the election and every later one awaits it and reads the CURRENT
state - not the first call's boolean, which goes stale the moment a follower is promoted. Two
concurrent callers therefore share one election instead of racing for the same lock.

**AND THE SAME END STATE HAD A SECOND ROUTE, closed in the same commit.** `releaseLeadership` gave
the lock away on a takeover and asked for nothing back, so once the tab that took over closed, the
demoted one was never told: read-only and offline for the rest of its life, same banner, same
absence of an explanation. Getting back in the queue is the one thing a tab handing over owes, and
`queueForPromotion` is now the single implementation both the losing candidate and the demoted
leader use.

Guarded by `mls-client/tabLeader.test.ts`, whose stub for these cases **models the lock** rather
than the two answers - the defect is invisible to a stub that cannot be held twice, which is why
fourteen existing cases were green over it.

### A take-over that reloads keeps the lock it took (2026-09-28)

**"Prendre la main" never stuck.** A promoted tab reloads to pick up the MLS state the old leader left
(WP-MULTITAB-1), and a Web Lock belongs to a DOCUMENT: the reload released the lock it had just been
granted. The tab it took over from had requeued at once (`releaseLeadership`, above), so it was granted
the lock back before the reloaded page could ask. Measured on production, one click:

```
19:25:33.243  Promoted to leader (Web Locks)
19:25:33.243  Leader promoted - reloading to pick up the MLS state left by the old leader.
19:25:33.991  Another tab is active - read-only mode (Web Locks).   <- the old leader has it again
19:25:34.249  Promoted to leader / reloading                        <- and the two trade it once more
19:25:35.297  Another tab is active - read-only mode (Web Locks).
```

**The reload is the same tab continuing, not a new candidate**, so it is marked as one: the promotion
handler calls `markPromotionReload()` (a one-shot key in the TAB's `sessionStorage`, which survives a
reload and no other tab reads), and the election of the page it starts requests the lock with
`steal: true` instead of `ifAvailable`. The mark is consumed by that election, so the tab's next
reload queues like any other. A leader whose lock is stolen sees its request reject with
`AbortError` and hands over exactly as a take-over does (`onLeaderLockRejected`: follower, back in the
queue, the demotion handler reloads it) - two tabs advancing one ratchet is what this module exists to
prevent. Guarded by the `a promotion reload reclaims the lock` cases in `tabLeader.test.ts`.

### A document on its way out took the lead back, and the take-over looped (2026-09-29)

**The fix above was not enough, and the user's console said why** (production `v0.18.29`, one
click): five promotions and five demotions in two seconds, alternating between the two tabs. Both
handlers reload after 50 ms, and the tab that yielded still requeued at once. So when the promoted
tab reloaded in its turn, the lock went back to the document that was LEAVING. That document was
promoted, marked a promotion reload, and on its next load stole the lock from the new page. The
mark had turned one hand-over into a relay race.

**A document whose demotion reloads it asks for nothing.** The demotion handler now answers
`'reloads'` when it ends the document (`useChatSession`), and `handOver()`, the one tail shared by
`releaseLeadership` and `onLeaderLockRejected`, then requeues nothing. The page the reload starts
runs its own election. A hand-over also clears any promotion mark it still holds
(`clearPromotionReload`), so a page cannot steal with a mark from a lead it already gave away. A
handler that returns nothing (a native shell, a test) keeps the old requeue, because that document
goes on living. Verified on the local estate, two tabs of W2: one click gives exactly one promotion
reload and one demotion, then 25 s stable, with the take-over button on the old tab only. Guarded by
the two `handOver` cases in `tabLeader.test.ts`.

### A follower pulled the leader's queue on every barrier (2026-09-28)

**Found in the same console.** `settleBarrier` pulls whenever no pull has emptied the mailbox *while
the socket was open* - right for a leader whose socket dropped, and true of a FOLLOWER at every call,
since a follower never opens one. Every `waitForMessageQueueIdle` therefore started a full pull: one
follower pulled the same 64 rows **37 times in ten seconds**, one per conversation its history
catch-up settled, and ran each through `processIncomingMessage` - decrypting, in a second tab, against
the ratchet the leader owns (WP-MULTITAB-1).

A follower's barrier now waits for its own scheduler and pulls nothing, and `fetchPendingMessages`
refuses on a follower at `error` level: every path that pulls is gated on leadership, so reaching it
is a caller that forgot. `undecided` is not `follower` - the boot pull runs after the election, and a
native client is always the leader. Guarded by `BaseMlsService.mailboxBarrier.test.ts`.

## Bugs fixed by the 2026-06 rewrite

| Bug ID | Description | Fix |
|---|---|---|
| S2 | Static fallback rotation | Rotated on every connection by `syncConnectionAfterWsOpen` |
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
