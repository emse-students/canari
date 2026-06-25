# chat-delivery-service

**Stack**: NestJS  
**Port**: 3010  
**Source**: `apps/chat-delivery-service/`

## Responsibilities

The chat-delivery-service is the MLS API layer. It:

- Manages device registration and key packages (static + one-time prekeys).
- Stores and routes MLS messages for offline devices (message queue in PostgreSQL).
- Publishes each queued message to Redis `chat:messages` for real-time delivery via the gateway.
- Maintains group and membership state (DeviceGroupMembership state machine).
- Handles the sync engine for cross-device conversation history (QR-code-based transfer).
- Dispatches push notifications via Firebase Cloud Messaging.
- Maintains a Redis Stream history per group (`history:{groupId}`) for replay.
- Performs background cleanup (cron jobs) for stale devices, expired messages, orphaned data.

## Databases

| Store | Purpose |
|---|---|
| PostgreSQL | Entities: KeyPackage, OneTimeKeyPackage, Group, GroupMember, DeviceGroupMembership, QueuedMessage, PinVerifier, PushToken, RevokedDevice |
| Redis | `chat:messages` pub/sub, `history:{groupId}` Streams, `group:members:{groupId}` sets, `add-lock:{groupId}`, `reboot-lock:{groupId}`, `pending_welcomes:{userId}` |
| Firebase | Push notifications (FCM) |

## Background jobs (cron)

| Interval | Task |
|---|---|
| 1h | Detect stale devices -> reset to pending |
| 1h | Clean expired queued messages |
| 1h | Full GC of stale device entries |
| 6h | Clean orphaned Redis `group:members:*` keys |
| 24h | Purge soft-deleted groups (> 90 days old) |
| 24h | Purge stale push tokens (> 90 days) |
| 24h | Purge orphaned member rows |
| 24h | Purge stale pending invitations (> 30 days) |

## Routes

All routes are under `/api/mls/*` or `/api/calls/*` and require `X-User-Id` (injected by Nginx) unless noted.

### Device management

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/register-device` | Register static key package for a device |
| POST | `/api/mls/register-device/prekeys` | Bulk-upload one-time prekeys |
| PATCH | `/api/mls/devices/:userId/:deviceId/metadata` | Update device name/OS/version |
| GET | `/api/mls/devices/:userId/:deviceId/key-package` | Get a consumable key package |
| GET | `/api/mls/devices/:userId` | List all registered devices for a user |
| GET | `/api/mls/devices/:userId/:deviceId/prekeys/count` | Count remaining OTKPs |
| GET | `/api/mls/devices/:userId/:deviceId/prekeys/list` | List published prekey IDs |
| POST | `/api/mls/devices/:userId/:deviceId/prekeys/prune` | Delete targeted orphaned prekeys |
| DELETE | `/api/mls/devices/:userId/:deviceId/prekeys` | Purge all prekeys for a device |
| DELETE | `/api/mls/devices/:userId/:deviceId` | Delete device and all its data |

### Group management

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/groups` | Create group record |
| GET | `/api/mls/groups/:groupId` | Get group metadata |
| PATCH | `/api/mls/groups/:groupId` | Rename group |
| PATCH | `/api/mls/groups/:groupId/image` | Set/clear group avatar |
| DELETE | `/api/mls/groups/:groupId` | Soft-delete group |
| POST | `/api/mls/groups/:groupId/successor` | Claim successor for dead group (CAS) |

### Membership

| Method | Path | Description |
|---|---|---|
| GET | `/api/mls/users/:userId/groups` | List user's groups |
| GET | `/api/mls/users/:userId/dismissed-groups` | List dismissed group IDs |
| POST | `/api/mls/users/:userId/dismissed-groups` | Mark group as dismissed |
| DELETE | `/api/mls/users/:userId/dismissed-groups/:groupId` | Un-dismiss group |
| POST | `/api/mls/groups/:groupId/members` | Add member record to group |
| GET | `/api/mls/groups/:groupId/user-members` | Get user-level members |
| GET | `/api/mls/groups/:groupId/members` | Get active device members |
| DELETE | `/api/mls/groups/:groupId/members/:userId` | Remove user from group |

### Messaging

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/send` | Send MLS message/commit (publishes to Redis, queues for offline devices) |
| POST | `/api/mls/commit` | Validate MLS commit epoch |
| POST | `/api/mls/welcome` | Deliver Welcome message to a device |
| POST | `/api/mls/welcome-request` | Broadcast welcome_request signal |
| DELETE | `/api/mls/welcome-request/group/:groupId` | Clear pending welcome_request queue |
| POST | `/api/mls/history/batch` | Get message history batch |
| GET | `/api/mls/history/:groupId` | Incremental Redis Stream history |
| GET | `/api/mls/messages/:userId/:deviceId` | Fetch queued messages for device |
| POST | `/api/mls/messages/ack` | Acknowledge received messages |
| POST | `/api/mls/notify-reaction` | Fire-and-forget reaction push |

### Invitations / device sync

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/groups/:groupId/invites` | Create shareable invite link |
| GET | `/api/mls/group-invites/:token` | Preview group invite |
| POST | `/api/mls/group-invites/:token/accept` | Accept group invite |
| GET | `/api/mls/invitations/pending/:userId/:deviceId` | Get pending invitations |
| GET | `/api/mls/device-memberships/:userId/:deviceId` | Get device memberships |
| POST | `/api/mls/invitations/status` | Upsert DeviceGroupMembership status |
| POST | `/api/mls/kick-stale-user` | Reset all devices for a user to pending |
| POST | `/api/mls/kick-stale-device` | Reset single device to pending |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId/:groupId` | Delete specific membership |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId` | Delete all device memberships |
| POST | `/api/mls/groups/:groupId/force_leave` | Force device exit from group |

### Sync engine (cross-device QR sync)

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/sync/session/start` | Create QR sync session |
| POST | `/api/mls/sync/session/join` | Join QR sync session |
| GET | `/api/mls/sync/session/:sessionId` | Poll sync session state |
| POST | `/api/mls/sync/session/manifest` | Upload message ID manifest |
| POST | `/api/mls/sync/session/diff` | Compute sync diff (missing messages) |
| POST | `/api/mls/sync/session/chunks/upload` | Upload encrypted message chunks |
| GET | `/api/mls/sync/session/:sessionId/chunks/pull` | Download sync chunks |
| POST | `/api/mls/sync/session/:sessionId/chunks/ack` | Acknowledge pulled chunks |

### Push notifications

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/mls/push/register` | JWT | Register/refresh FCM push token |
| DELETE | `/api/mls/push/unregister/:deviceId` | JWT | Unregister push token |
| GET | `/api/mls/push/fetch-proto` | PushSecret | Fetch proto for background push service |
| GET | `/api/mls/push/avatar/:targetUserId` | PushSecret | Get avatar URL for notification display |
| POST | `/api/mls/push/refresh-token` | PushSecret | Refresh FCM token |
| POST | `/api/mls/push/membership-active` | PushSecret | Mark membership active after push-triggered add |
| POST | `/api/mls/push/acquire-add-lock` | PushSecret | Acquire add-lock from background service |
| DELETE | `/api/mls/push/release-add-lock` | PushSecret | Release add-lock |
| GET | `/api/mls/push/key-package` | PushSecret | Get key package for background service |
| POST | `/api/mls/push/send-welcome-and-commit` | PushSecret | Send Welcome + commit from background service |
| POST | `/api/mls/push/send` | PushSecret | Send message from background service |
| POST | `/api/mls/push/broadcast-test` | JWT | Test push to all devices of caller |

### Security / PIN

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/security/pin-check` | Check/register PIN verifier (PBKDF2) |
| GET | `/api/mls/security/pin-status/:userId` | Check if PIN is registered |
| POST | `/api/mls/security/pin-change` | Change PIN verifier |
| POST | `/api/mls/security/pin-reset` | Reset PIN (purge devices, keep memberships) |
| GET | `/api/mls/link-preview` | Fetch safe external URL preview |
| GET | `/api/mls/gallery-cover/:albumId` | Proxy MiGallery album cover image |

### Distributed locks

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/add-lock` | Acquire distributed add-lock |
| DELETE | `/api/mls/add-lock` | Release add-lock |
| POST | `/api/mls/reboot-lock` | Acquire reboot-lock |
| DELETE | `/api/mls/reboot-lock` | Release reboot-lock |

### Calls

| Method | Path | Description |
|---|---|---|
| POST | `/api/calls/initiate` | Verify membership, return LiveKit room token + room ID |
| GET | `/api/calls/room-token` | Get room token for recipient |
| GET | `/api/calls/ice-servers` | Get ICE server configuration |
| POST | `/api/calls/presence` | Report device presence in call |
| GET | `/api/calls/sibling-status` | Check sibling device call status |

### Internal / health

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/internal/push/notify` | InternalSecret | Send push via internal secret |
| DELETE | `/api/internal/users/:userId` | InternalSecret | Delete all user MLS/device data |
| GET | `/api/health` | none | Liveness probe |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `REDIS_URL` | yes | Redis connection string |
| `JWT_SECRET` | yes | HS256 secret (shared with core-service) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | no | Firebase Admin SDK credentials (push notifications) |
| `PUSH_SECRET` | yes | Shared secret for background push service routes |
| `INTERNAL_SECRET` | yes | Shared secret for internal service-to-service routes |
| `LIVEKIT_API_KEY` | no | LiveKit API key (calls) |
| `LIVEKIT_API_SECRET` | no | LiveKit API secret (calls) |
| `LIVEKIT_URL` | no | LiveKit server URL (calls) |
