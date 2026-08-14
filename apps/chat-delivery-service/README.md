# Chat Delivery Service

NestJS microservice for the MLS API layer. Runs on port **3010**.

## Domains

### Device Registration

Static and one-time prekeys for device enrollment:

- **Register device**: POST `/api/mls/register-device` - upload static key package and metadata.
- **Prekeys**: bulk upload, consume, prune, list, count.
- **Key package resolution**: get consumable key packages for device-to-device encryption.
- **Device list**: GET all devices for a user, with revocation status and metadata.

### Message Queue and Delivery

Offline device message routing:

- Stores and routes MLS messages in PostgreSQL queue for offline devices.
- Publishes queued messages to Redis `chat:messages` for real-time delivery via the gateway.
- Bounded by retention window (90 days); no size cap.
- Per-device queue depth monitored and warned above threshold (2000 rows or threshold by bytes).

### Group and Membership

Group creation, membership, and device state machine:

- Create/list groups and manage group metadata.
- Add/remove members; track per-device membership status via `DeviceGroupMembership` state machine.
- Soft-delete groups (90-day purge window).
- Group history stored in Redis Stream (`history:{groupId}`) with configurable retention (default 8000 entries).

### Messaging

MLS message flow:

- **Send**: POST `/api/mls/send` - publish to Redis and queue for offline devices.
- **Commit**: atomic commit validation, epoch storage, fan-out.
- **Replay**: ordered commits to catch lagging devices; bounded history walks.
- **Welcome**: distribute Welcome messages to newly-added members.
- **History**: Redis Stream fetch with cursor-based pagination (bounded by byte and row limits per page).

### Push Notifications

Firebase Cloud Messaging for both platforms:

- Register/refresh FCM tokens (JWT auth, with optional iOS VoIP token).
- Dispatch messages via FCM gateway (`getMessaging().send()`).
- APNs delivery relayed through FCM.
- Background foreground handlers for Android and iOS (`MlsBackgroundWorker`, `BGProcessingTask`).
- Rich notifications with media thumbnails (2 MB cap).
- Quick-reply and mark-as-read inline actions.
- App-icon unread badge (distinct conversations).
- Priority calls via APNs VoIP push (iOS) or high-priority FCM (Android).

### Security and Links

PIN-based device access control and safe link previews:

- PIN check/register, change, reset.
- Revoked device list (10-year TTL).
- Link preview fetch (SSRF-guarded via undici dispatcher) and image proxy.
- Google Safe Browsing verdict endpoint.
- Gallery album cover proxy.

### Background Cleanup

Hourly and daily cron jobs:

- Detect and reset stale devices (past retention window).
- Clean expired queued messages.
- Purge orphaned Redis keys and device entries.
- Purge soft-deleted groups and push tokens.
- Purge stale pending invitations and revocations.

## Databases

| Store | Purpose |
|---|---|
| PostgreSQL | Device key packages, groups, memberships, queued messages, revoked devices, push tokens |
| Redis | `chat:messages` pub/sub, `history:{groupId}` Streams, `group:members:{groupId}` sets, group locks, pending welcome fan-out |
| Firebase | Push notifications (FCM/APNs gateway) |

## Startup

```bash
cd apps/chat-delivery-service
npm run start:dev
```

Requires running PostgreSQL, Redis, and Firebase credentials.

## See also

- [Wiki: chat-delivery-service](../../docs/wiki/services/chat-delivery.md) - Full API reference, queue architecture, push design
- [Wiki: MLS protocol](../../docs/wiki/protocols/mls-protocol.md) - End-to-end encryption and device key material
- [Wiki: History reconciliation](../../docs/wiki/protocols/history-reconciliation.md) - Message history replay and consistency
