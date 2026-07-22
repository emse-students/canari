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
| Redis | `chat:messages` pub/sub, `history:{groupId}` Streams, `group:members:{groupId}` sets, `add-lock:{groupId}`, `pending_welcomes:{userId}` |
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
| POST | `/api/mls/commit` | Validate commit epoch + store in commit-log + fan out (one atomic call) |
| GET | `/api/mls/commits/:groupId?sinceEpoch=N` | Rung-1 replay: ordered commits to catch up a lagging device |
| GET | `/api/mls/group-info/:groupId` | Latest GroupInfo for external-join (membership-gated) |
| POST | `/api/mls/group-info/:groupId` | Refresh stored GroupInfo (membership-gated, monotonic) |
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
| GET | `/api/mls/push/media/:mediaId` | PushSecret | Proxy encrypted media ciphertext (2 MB cap) for a notification thumbnail |
| POST | `/api/mls/push/refresh-token` | PushSecret | Refresh FCM token |
| POST | `/api/mls/push/membership-active` | PushSecret | Mark membership active after push-triggered add |
| POST | `/api/mls/push/acquire-add-lock` | PushSecret | Acquire add-lock from background service |
| DELETE | `/api/mls/push/release-add-lock` | PushSecret | Release add-lock |
| GET | `/api/mls/push/key-package` | PushSecret | Get key package for background service |
| POST | `/api/mls/push/send-welcome-and-commit` | PushSecret | Send Welcome + commit from background service |
| POST | `/api/mls/push/send` | PushSecret | Send message from background service |
| POST | `/api/mls/push/broadcast-test` | JWT | Test push to all devices of caller |

#### Transport — single gateway (FCM)

Both platforms are delivered through **Firebase Cloud Messaging**; there is no direct
APNs provider in the backend. For each `PushToken`, `MessagingService` issues one
`getMessaging().send()` carrying:

- a `data` map — read by Android's `onMessageReceived` (fires foreground **and** background);
- an `android` block (`priority: high`, 24 h TTL);
- an `apns` block, shaped by `buildApnsRequest` in `push-payload.ts`.

FCM applies the `android` block to Android tokens and **relays the `apns` block to Apple's
APNs** for iOS tokens, using the APNs `.p8` auth key uploaded in the Firebase console
(Project Settings → Cloud Messaging → APNs Authentication Key). Visible iOS pushes carry
`mutable-content: 1` so a Notification Service Extension can decrypt and rewrite the alert
(until that extension ships, the generic fallback title/body is shown); silent frames carry
`content-available: 1`, mirroring the Android data-only push. iOS clients register their
**FCM** token (not a raw APNs device token) via `/api/mls/push/register` with `platform: "ios"`.

**Client config & build:** the Firebase client config files are gitignored and injected by CI
from secrets — `GOOGLE_SERVICES_JSON` (Android → `google-services.json`) and
`GOOGLE_SERVICE_INFO_PLIST` (iOS → `canari_iOS/GoogleService-Info.plist`). The iOS Firebase
SDK is pulled via **Swift Package Manager** (not CocoaPods). The APNs↔FCM token bridge relies
on Firebase's App Delegate Proxy (`FirebaseAppDelegateProxyEnabled`, which must stay enabled).
The iOS `aps-environment` entitlement is `production` for TestFlight/App Store builds.

#### iOS background execution

Android drains the pending MLS state from an expedited `MlsBackgroundWorker` (WorkManager). The
iOS peer is a **`BGProcessingTask`** (`fr.emse.canari.cleanup`, listed in
`BGTaskSchedulerPermittedIdentifiers`): its launch handler is registered in `canari_ios_bootstrap`
(before `UIApplicationMain`, as `BGTaskScheduler` demands) and runs
`canari_native_cleanup_pending_db` to clear `mls_pending.db`. A request is re-submitted on every
background entry (`willResignActive`) and after each run, but iOS decides when — there is no
guaranteed cadence.

**Force-quit is terminal on iOS:** once the user swipes the app away, iOS delivers **no** silent
`content-available` data pushes and runs **no** `BGTask` until the app is manually relaunched. This
is a platform constraint with no workaround; visible (`mutable-content`) alert pushes still arrive
and wake the (future) Notification Service Extension, so the user is never fully silenced, but
background state-sync only resumes on next open. Android has no equivalent restriction.

#### Notification quick actions (reply / mark as read)

Both platforms attach two inline actions to an MLS message notification (never on a `channel_`
conversation - channels are server-authoritative, no MLS outbox to route through): "Repondre"
(text input) and "Marquer comme lu". Both fire while the app is fully killed - Android via a
`BroadcastReceiver`, iOS via a brief OS relaunch to deliver `didReceiveNotificationResponse`.

Since the TS runtime that normally builds an `AppMessage` proto isn't running, a minimal
dependency-free protobuf encoder (`mobile::proto_fields::build_text_app_message` /
`build_read_receipt_app_message` in `frontend/src-tauri/src/mobile/proto_fields.rs`) is exposed
identically to Android JNI (`nativeBuildTextMessageProto`/`nativeBuildReadReceiptProto` on
`CanariFirebaseMessagingService`) and iOS FFI (`canari_native_build_text_message_proto`/
`canari_native_build_read_receipt_proto`). Both actions reuse the existing outbox-drain path
unchanged: the built proto is appended to the `outbox_pending.ndjson` mirror and drained
immediately via the same `drainOutboxBackground`/JNI-or-FFI encrypt + `/api/mls/push/send` call
the background welcome-join/decrypt flows already use.

- **Reply** queues a plaintext `TextMsg` entry (`silent: false`) and only clears the notification
  once the drain actually delivers it (0 remaining) - a queued-but-undelivered reply keeps the
  notification so the user can retry from the app.
- **Mark as read** clears the notification immediately (visible feedback), then best-effort sends
  a silent `SystemMsg{event:"read_receipt"}` (`silent: true`) covering every messageId cached for
  that conversation in `fcm_message_cache.ndjson`. This is cross-device sync only - a peer/sibling
  device receiving that silent push cancels its own notification (existing read-state-sync path);
  this device's local unread-badge/readBy state is not reconciled and self-corrects next time the
  conversation is opened in-app.
- Android: `CanariNotificationActionReceiver.kt` (`ACTION_QUICK_REPLY`/`ACTION_MARK_READ`
  broadcasts). The outbox/notification helpers it shares with `CanariFirebaseMessagingService` live
  in that service's companion object, taking an explicit `Context` param (a bare
  `CanariFirebaseMessagingService()` instance is Context-unsafe - `Service` extends
  `ContextWrapper`, and `attachBaseContext` is never called on a manually-instantiated one).
- iOS: `CanariRegisterNotificationCategories`/`CanariHandleQuickReplyAction`/
  `CanariHandleMarkReadAction` in `canari_push.mm`, wired into `CanariNotificationDelegate`'s
  `didReceiveNotificationResponse`.
- iOS gotcha: the action buttons only appear when the delivered notification carries
  `categoryIdentifier == "canari_message_category"`. The app-alive path stamps it in
  `CanariShowLocalNotification`, but when the app is fully killed the NSE
  (`canari_NSE/NotificationService.swift` `applyMessageContent`) is the ONLY path that builds the
  visible alert, so it must stamp the same id too (MLS DM/group only) - the backend APNs payload
  does not send `aps.category`. iOS retains the category the app registered across termination, so
  the stamp is enough.
- Gotcha: the outbox mirror rewrite (both platforms) must persist the `silent` flag on every
  write, or a control event that survives one failed drain attempt loses its silent flag on retry
  and resends as a visible push.

#### App-icon unread badge

The launcher/home-screen badge mirrors the number of **distinct unread conversations** (not
messages). It is driven entirely off the currently displayed message notifications, so it moves up
on push receipt and down on read-state cancel with no separate counter to keep in sync.

- **Android** (`CanariFirebaseMessagingService`): `countUnreadConversations` counts the active
  message notifications (excluding the group summary and the pending-sync nudge), and
  `refreshBadgeSummary` rebuilds the group summary carrying that count via `setNumber(count)` (or
  cancels the summary when it hits 0). It is the single source of truth for both the summary and the
  badge, called after every message notification post (`showNotification`) and every cancel
  (`cancelConversationNotification`); `cancelAllMessageNotifications` clears the summary and thus the
  badge on app open. Numeric badges are honored by stock Android / Pixel / recent OEM launchers;
  some older launchers only show a dot (no third-party ShortcutBadger dependency).
- **iOS** has two writers because the badge owner depends on process state:
  - App alive (`canari_push.mm`): `CanariUpdateAppBadge` recomputes from the delivered chat
    notifications and calls `setBadgeCount` (iOS 16+) / `applicationIconBadgeNumber`, after
    `CanariShowLocalNotification` (message threads only) and both cancel paths
    (`CanariCancelConversationNotification`, `CanariPushCancelMessageNotifications`).
  - App killed (`canari_NSE/NotificationService.swift`): the extension writes `content.badge`
    directly (no `UIApplication` in an extension) via `applyBadgeCount`, counting the delivered chat
    conversations plus the incoming one.
  - Both count a conversation by its per-conversation `threadIdentifier` (NSE deliveries, WP-iOS-7)
    or the stable request id (flat `canari_messages` thread, in-app deliveries) - both are unique
    per conversation - and gate on `threadIdentifier == "canari_messages"` or a
    `fr.emse.canari://chat` deep link so social/form notifications never count.

#### Rich media notifications (image/GIF thumbnail)

An image or GIF message shows its decrypted thumbnail inside the notification, on both platforms and
while the app is fully killed (WP-XP-3). Scope is **images + GIF only**: video/audio keep the existing
text preview (`📷 Photo` / `🎥 Vidéo` ...). This is the MLS DM/group path only - community channels
keep their text preview.

Because media is end-to-end encrypted (the media service stores only opaque AES-256-GCM ciphertext,
the CEK/IV live inside the MLS message), the native notification builder must fetch and decrypt the
blob itself:

1. **Decrypt metadata**: the shared Rust parser `extract_full_message_info` (`proto_fields.rs`) now
   emits `mediaId` + base64 `mediaKey`/`mediaIv` + `mimeType` alongside `mediaKind` for a `MediaMsg`.
   These ride the same decrypt JSON both platforms already parse.
2. **Fetch ciphertext**: a killed app has no user JWT, so the blob is pulled through a new
   PushSecret-authed proxy `GET /api/mls/push/media/:mediaId` (chat-delivery), which relays it from
   media-service's server-to-server `GET /api/media/internal/:id` (X-Internal-Secret gate). A **2 MB
   cap** (matching client-side send compression) keeps videos and oversized blobs out - above it the
   proxy returns 413 and the native side shows the text-only notification.
3. **Decrypt blob**: a new leaf FFI decrypts the ciphertext with the CEK, reusing the channel AES-GCM
   path (`background::decrypt_media_blob`). Android JNI `nativeDecryptMedia(keyB64, ivB64, ciphertext)`
   returns the plaintext bytes; iOS C-ABI `canari_native_decrypt_media(..., out_len)` returns a heap
   buffer freed with `canari_free_bytes`. The plaintext (original image bytes) never transits the
   server or FCM.
4. **Attach**:
   - **Android** (`CanariFirebaseMessagingService.fetchAndDecryptMedia`): writes the decrypted image
     under the FileProvider-mapped cache dir (`cacheDir/tauri/notif_media/`, 24 h sweep) and attaches
     it inline via `MessagingStyle.Message.setData(mime, contentUri)` - preserving conversation
     stacking + quick actions. NotificationManager grants SystemUI read access to the content URI.
   - **iOS** attaches a `UNNotificationAttachment` from a decrypted temp file. Since iOS shows only the
     first image attachment as the banner preview, the **media thumbnail outranks the sender avatar**
     (avatar is used only for text/non-image). App alive: `canari_push.mm`
     `CanariFetchAndDecryptMedia` → `CanariShowLocalNotification`. App killed:
     `canari_NSE/NotificationService.swift` `fetchAndDecryptMedia` → `attachImage`.

Gotcha: only `mediaKind == "image"` (which also covers GIF, mime `image/gif`) is rendered; the
extension budget (~30 s) and the 2 MB cap bound the background download + decrypt.

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
