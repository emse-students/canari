# API surface

Full endpoint inventory across all services. The Nginx routing table in `docs/wiki/infrastructure/nginx.md` is the public surface; this page lists the service-level endpoints.

Auth on all protected routes is injected by Nginx (`auth_request`): services receive `X-User-Id`, `X-Logged-In`, `X-Global-Admin` headers.

---

## chat-gateway (port 3000)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/ws` | yes (JWT cookie) | WebSocket upgrade |
| GET | `/api/presence` | yes | Online presence for a user |
| GET | `/api/admin/presence` | yes (global admin) | Admin view of all connected devices |
| GET | `/api/health` | no | Liveness probe |

WebSocket frames: see `docs/wiki/services/chat-gateway.md`.

---

## chat-delivery-service (port 3010)

### Device management

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/register-device` | Register static key package |
| POST | `/api/mls/register-device/prekeys` | Bulk-upload one-time prekeys |
| PATCH | `/api/mls/devices/:userId/:deviceId/metadata` | Update device metadata |
| GET | `/api/mls/devices/:userId/:deviceId/key-package` | Get consumable key package |
| GET | `/api/mls/devices/:userId` | List all devices for a user |
| GET | `/api/mls/devices/:userId/:deviceId/prekeys/count` | Count remaining OTKPs |
| GET | `/api/mls/devices/:userId/:deviceId/prekeys/list` | List published prekey IDs |
| POST | `/api/mls/devices/:userId/:deviceId/prekeys/prune` | Delete orphaned prekeys |
| DELETE | `/api/mls/devices/:userId/:deviceId/prekeys` | Purge all prekeys for device |
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
| POST | `/api/mls/users/:userId/dismissed-groups` | Mark group dismissed |
| DELETE | `/api/mls/users/:userId/dismissed-groups/:groupId` | Un-dismiss group |
| POST | `/api/mls/groups/:groupId/members` | Add member record |
| GET | `/api/mls/groups/:groupId/user-members` | Get user-level members |
| GET | `/api/mls/groups/:groupId/members` | Get active device members |
| DELETE | `/api/mls/groups/:groupId/members/:userId` | Remove user from group |

### Messaging

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/send` | Send MLS message/commit |
| POST | `/api/mls/commit` | Validate commit epoch + store in commit-log + fan out |
| GET | `/api/mls/commits/:groupId?sinceEpoch=N` | Rung-1 replay: ordered commits since epoch N |
| GET | `/api/mls/group-info/:groupId` | Latest GroupInfo for external-join (membership-gated) |
| POST | `/api/mls/group-info/:groupId` | Refresh stored GroupInfo (membership-gated, monotonic) |
| POST | `/api/mls/welcome` | Deliver Welcome to device |
| POST | `/api/mls/welcome-request` | Broadcast welcome_request signal |
| DELETE | `/api/mls/welcome-request/group/:groupId` | Clear pending welcome_request queue |
| POST | `/api/mls/history/batch` | Get message history batch |
| GET | `/api/mls/history/:groupId` | Incremental Redis Stream history |
| GET | `/api/mls/messages/:userId/:deviceId` | Fetch queued messages |
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
| POST | `/api/mls/invitations/status` | Upsert DeviceGroupMembership |
| POST | `/api/mls/kick-stale-user` | Reset all devices for user to pending |
| POST | `/api/mls/kick-stale-device` | Reset single device to pending |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId/:groupId` | Delete specific membership |
| DELETE | `/api/mls/device-memberships/:userId/:deviceId` | Delete all device memberships |
| POST | `/api/mls/groups/:groupId/force_leave` | Force device exit from group |

### Sync engine (cross-device QR)

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/sync/session/start` | Create QR sync session |
| POST | `/api/mls/sync/session/join` | Join QR sync session |
| GET | `/api/mls/sync/session/:sessionId` | Poll sync session state |
| POST | `/api/mls/sync/session/manifest` | Upload message ID manifest |
| POST | `/api/mls/sync/session/diff` | Compute sync diff |
| POST | `/api/mls/sync/session/chunks/upload` | Upload encrypted chunks |
| GET | `/api/mls/sync/session/:sessionId/chunks/pull` | Download sync chunks |
| POST | `/api/mls/sync/session/:sessionId/chunks/ack` | Acknowledge pulled chunks |

### Push notifications

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/mls/push/register` | JWT | Register FCM push token |
| DELETE | `/api/mls/push/unregister/:deviceId` | JWT | Unregister push token |
| POST | `/api/mls/push/broadcast-test` | JWT | Test push to all devices |
| GET | `/api/mls/push/fetch-proto` | PushSecret | Fetch proto for background service |
| GET | `/api/mls/push/avatar/:targetUserId` | PushSecret | Get avatar for notification |
| POST | `/api/mls/push/refresh-token` | PushSecret | Refresh FCM token |
| POST | `/api/mls/push/membership-active` | PushSecret | Mark membership active |
| POST | `/api/mls/push/acquire-add-lock` | PushSecret | Acquire add-lock |
| DELETE | `/api/mls/push/release-add-lock` | PushSecret | Release add-lock |
| GET | `/api/mls/push/key-package` | PushSecret | Get key package |
| POST | `/api/mls/push/send-welcome-and-commit` | PushSecret | Send Welcome + commit |
| POST | `/api/mls/push/send` | PushSecret | Send message (background) |

### Security / PIN

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/security/pin-check` | Check/register PIN verifier (PBKDF2) |
| GET | `/api/mls/security/pin-status/:userId` | Check if PIN registered |
| POST | `/api/mls/security/pin-change` | Change PIN verifier |
| POST | `/api/mls/security/pin-reset` | Reset PIN (purge devices) |
| GET | `/api/mls/link-preview` | Fetch safe external URL preview |
| GET | `/api/mls/gallery-cover/:albumId` | Proxy MiGallery album cover |

### Distributed locks

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/add-lock` | Acquire distributed add-lock |
| DELETE | `/api/mls/add-lock` | Release add-lock |

### Calls

| Method | Path | Description |
|---|---|---|
| POST | `/api/calls/initiate` | Verify membership, return LiveKit room token |
| GET | `/api/calls/room-token` | Get room token for recipient |
| GET | `/api/calls/ice-servers` | Get ICE server config |
| POST | `/api/calls/presence` | Report device presence in call |
| GET | `/api/calls/sibling-status` | Check sibling device call status |

### Internal / health

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/internal/push/notify` | InternalSecret | Send push via internal secret |
| DELETE | `/api/internal/users/:userId` | InternalSecret | Delete all user MLS/device data |
| GET | `/api/health` | none | Liveness probe |

---

## call-service (port 3004)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/calls/ws` | yes (JWT cookie) | WebRTC SFU WebSocket upgrade |
| GET | `/api/health` | no | Liveness probe |

Signal frames (JSON over WebSocket): `Join { room_id, room_token }`, `Joined`, `Offer`, `Answer`, `IceCandidate`. See [`services/call-service.md`](../services/call-service.md) for the protocol.

---

## media-service (port 3011)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/media/upload` | JWT | Upload encrypted blob, return `mediaId` |
| POST | `/api/media/upload/public` | JWT | Upload public image (auto-resized 512x512 WebP) |
| POST | `/api/media/upload/chunk/init` | JWT | Initialize chunked upload session |
| POST | `/api/media/upload/chunk/:id` | JWT | Append chunk (max 50 MB) |
| POST | `/api/media/upload/chunk/:id/complete` | JWT | Complete chunked upload |
| GET | `/api/media/public/:id` | none | Download public asset (cached 1 year) |
| GET | `/api/media/:id` | JWT | Download encrypted blob (no-cache) |
| DELETE | `/api/media/:id` | JWT | Delete media blob (owner only) |

---

## core-service (port 3012)

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/oidc/callback` | none | Exchange OIDC code for JWT + refresh cookie |
| POST | `/api/auth/refresh` | cookie | Rotate refresh cookie, return new access token |
| POST | `/api/auth/logout` | cookie | Clear refresh cookie |
| GET | `/api/auth/verify` | Bearer | JWT validation for Nginx auth_request |
| HEAD | `/api/auth/verify` | Bearer | Same as GET |

### Users

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/users/search?q=...` | JWT | Search users by id/displayName |
| GET | `/api/users/directory` | JWT | Paginated directory |
| GET | `/api/users/:id/avatar` | JWT | Get user avatar |
| POST | `/api/users` | global admin | Create user manually |
| GET | `/api/users/me/notes` | JWT | Get private notepad |
| PUT | `/api/users/me/notes` | JWT | Update private notepad |
| GET | `/api/users/:id` | JWT | Get public profile |
| PATCH | `/api/users/me` | JWT | Update profile |
| DELETE | `/api/users/me` | JWT | Delete account and all data |
| GET | `/api/users/admin/list` | global admin | List all users |
| PATCH | `/api/users/:id/admin` | global admin | Set/clear admin flag |
| GET | `/api/users/admin/platform` | global admin | Get platform config |
| PATCH | `/api/users/admin/platform` | global admin | Update platform config |
| GET | `/api/version` | none | App version + platform gates |

### Payments

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/payments/onboarding` | JWT | Start Stripe Connect onboarding |
| GET | `/api/payments/connect-status/:associationId` | JWT | Stripe Connect status |
| POST | `/api/payments/connect-dashboard-link/:associationId` | JWT | Stripe Dashboard link |
| POST | `/api/payments/create-checkout-session` | JWT | Create Checkout session |
| POST | `/api/payments/verify-session` | JWT | Verify completed checkout |
| POST | `/api/payments/cancel-session` | JWT | Cancel unpaid checkout |
| POST | `/api/payments/setup-payment-method` | JWT | Setup saved card |
| GET | `/api/payments/payment-methods` | JWT | List saved cards |
| DELETE | `/api/payments/payment-methods/:id` | JWT | Detach saved card |
| POST | `/api/payments/charge-saved-method` | JWT | Charge saved card (form) |
| POST | `/api/payments/charge-product-saved-method` | JWT | Charge saved card (product) |
| POST | `/api/payments/internal/customer-id` | InternalSecret | Get/create Stripe customer |
| POST | `/api/payments/webhook` | Stripe signature | Stripe webhook handler |

---

## social-service (port 3014)

### Posts

| Method | Path | Description |
|---|---|---|
| GET | `/api/posts` | Paginated feed |
| POST | `/api/posts` | Create post |
| GET | `/api/posts/:postId` | Get post |
| PATCH | `/api/posts/:postId` | Update post |
| DELETE | `/api/posts/:postId` | Delete post |
| POST | `/api/posts/:postId/reactions` | Add/toggle reaction |
| POST | `/api/posts/:postId/comments` | Add comment |
| PATCH | `/api/posts/:postId/pin` | Pin post (admin) |
| PATCH | `/api/posts/:postId/unpin` | Unpin post (admin) |
| POST | `/api/posts/:postId/report` | Report post |

### Channels

| Method | Path | Description |
|---|---|---|
| POST | `/api/channels/workspaces` | Create workspace |
| GET | `/api/channels/workspaces/user/me` | List caller's workspaces (each carries `viewerCanManage`: true iff the caller holds MANAGE_WORKSPACE, used to gate admin controls) |
| GET | `/api/channels/workspace/:workspaceId/user/me` | List channels for caller |
| POST | `/api/channels` | Create channel |
| POST | `/api/channels/:channelId/messages` | Send encrypted message |
| POST | `/api/channels/:channelId/members/join` | Join channel |
| POST | `/api/channels/:channelId/members/invite` | Invite user |
| POST | `/api/channels/:channelId/members/kick` | Kick member |
| POST | `/api/channels/:channelId/members/leave` | Leave channel |
| POST | `/api/channels/:channelId/messages/:messageId/pin` | Pin message |

### Forms

| Method | Path | Description |
|---|---|---|
| POST | `/api/forms` | Create form |
| GET | `/api/forms` | List caller's forms |
| GET | `/api/forms/:id` | Get form definition |
| POST | `/api/forms/:id/submit` | Submit form |
| GET | `/api/forms/:id/submissions` | List submissions (owner only) |
| POST | `/api/forms/:id/image` | Upload form banner image |

### Associations

| Method | Path | Description |
|---|---|---|
| GET | `/api/associations` | List all associations |
| GET | `/api/associations/:id` | Get association |
| POST | `/api/associations` | Create association (admin) |
| PATCH | `/api/associations/:id` | Update association |
| POST | `/api/associations/:id/members` | Add member |
| POST | `/api/associations/:id/events` | Create calendar event |
| POST | `/api/associations/:id/products` | Create product |
| POST | `/api/associations/:id/products/:productId/checkout` | Stripe checkout for product |
