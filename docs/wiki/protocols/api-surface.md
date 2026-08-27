# API surface

Full endpoint inventory across all services. The Nginx routing table in `docs/wiki/infrastructure/nginx.md` is the public surface; this page lists the service-level endpoints.

Auth on all protected routes is injected by Nginx (`auth_request`): services receive `X-User-Id`, `X-Logged-In`, `X-Global-Admin` headers.

## Internal cross-service calls

**AN INTERNAL CALL CARRIES THE CALLEE'S GLOBAL PREFIX, OR IT IS A 404 NOBODY READS.** Every Nest
service mounts `setGlobalPrefix('api')`, while the internal base URLs are configured without it.
Six of seven internal callers omitted it, and because all six were `.catch(warn)` the platform ran
that way indefinitely: channel push never delivered on any device, `userHasMlsDevices` reduced to a
constant `true` (not a degraded guard - none at all), and account deletion left MLS keys, devices,
messages, posts, follows and memberships in place.

Fixed at the seam rather than at the call sites: one `internal/service-urls.ts` per service. The
failure mode is the lesson - a `.catch(warn)` written for a transient fault met a permanent one and
turned it into silence. Found by reading the server logs (`srvlog.mjs`), invisible to every client.

**AND A PREFIX IS ONLY HALF OF AN ADDRESS: THE GUARD IS THE OTHER HALF.** With the prefix corrected,
`fetchUserDeviceCount` still called `GET /api/mls/devices/:userId`, which is a USER route behind
`HeaderAuthGuard` - it wants `x-user-logged-in` and a per-minute HMAC that only Nginx mints, and a
container-to-container call carries `X-Internal-Secret` and nothing else. The route answered 401 to
every one of them. It went unseen while `userHasMlsDevices` failed open, and became a 503 on every
DIRECT community invitation the day it stopped (2026-08-19); COMM-4 asked for one on 2026-08-20 and
the check reported VACUOUS, which is what located it. The internal counterpart below is now the one
called. **A route addressed to users is not an internal API with a longer path**, and a caller that
guesses a callee's route guesses its guard with it.

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
| POST | `/api/mls/history/batch` | Get message history batch, at most 50 groups ([why the cap is a contract](../services/chat-delivery.md#messaging)) |
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

### Distributed locks

| Method | Path | Description |
|---|---|---|
| POST | `/api/mls/add-lock` | Acquire distributed add-lock |
| DELETE | `/api/mls/add-lock` | Release add-lock |

### Calls

| Method | Path | Description |
|---|---|---|
| POST | `/api/calls/initiate` | Verify membership, return a room token for the `call-service` SFU |
| GET | `/api/calls/room-token` | Get room token for recipient |
| GET | `/api/calls/ice-servers` | Get ICE server config |
| POST | `/api/calls/presence` | Report device presence in call |
| GET | `/api/calls/sibling-status` | Check sibling device call status |

### Internal / health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/internal/mls/devices/:userId/count` | InternalSecret | How many devices a user has, inside the retention window - the service-facing counterpart of `GET /api/mls/devices/:userId` |
| POST | `/api/internal/push/notify` | InternalSecret | Send push via internal secret |
| DELETE | `/api/internal/users/:userId` | InternalSecret | Delete all user MLS/device data |
| DELETE | `/api/internal/follows/between/:userA/:userB` | InternalSecret | Drop both follows between two accounts - called by core-service when one blocks the other |
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
| GET | `/api/users/search?q=...` | JWT | Search users by id/displayName. Excludes accounts a block stands between, in either direction |
| GET | `/api/users/directory` | JWT | Paginated directory |
| GET | `/api/users/:id/avatar` | JWT | Get user avatar |
| POST | `/api/users` | global admin | Create user manually |
| GET | `/api/users/me/notes` | JWT | Get private notepad |
| PUT | `/api/users/me/notes` | JWT | Update private notepad |
| GET | `/api/users/:id` | JWT | Get public profile |
| PATCH | `/api/users/me` | JWT | Update profile |
| DELETE | `/api/users/me` | JWT | Delete account and all data |
| GET | `/api/users/me/blocks` | JWT | People the caller has blocked |
| POST | `/api/users/me/blocks` | JWT | Block a person (idempotent) |
| DELETE | `/api/users/me/blocks/:blockedId` | JWT | Lift a block |
| GET | `/api/users/:otherUserId/block-status` | JWT | Whether a block stands between the caller and this account |
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

### Channels

| Method | Path | Description |
|---|---|---|
| POST | `/api/channels/workspaces` | Create workspace |
| GET | `/api/channels/workspaces/user/me` | List caller's workspaces (each carries `viewerCanManage`: true iff the caller holds MANAGE_WORKSPACE, used to gate admin controls) |
| GET | `/api/channels/workspaces/by-slug/:slug` | One workspace with its readable channels, members and roles. **Members only**, and channels are projected rather than returned as entities. That projection was what kept `channels.masterSecret` off the wire; migration 041 dropped the column outright, so there is no longer a secret to leak, and the projection stays as the narrow contract |
| DELETE | `/api/channels/workspaces/:workspaceId` | Delete a community for every member, irreversibly. MANAGE_WORKSPACE only, and the body must carry `{confirmationName}` equal to the community's name - `WORKSPACE_CONFIRMATION_MISMATCH` otherwise, which is also what an older client gets, since it sends no such field |
| GET | `/api/channels/workspace/:workspaceId/user/me` | List channels for caller |
| POST | `/api/channels/workspaces/:workspaceId/leave` | Leave a community. Refuses the sole admin (`WORKSPACE_WOULD_HAVE_NO_ADMIN`); the last member leaving deletes the community |
| DELETE | `/api/channels/workspaces/:workspaceId/members/:userId` | Kick. Consults the TARGET's roles, same refusal |
| POST | `/api/channels/workspaces/:workspaceId/invites` | Returns THE live invite (`{token, expiresAt, maxUses, uses}`), minting one if none. `rotate: true` revokes the live token and mints its replacement - the only way to get a new one |
| GET | `/api/channels/workspaces/:workspaceId/distribution-group` | The community's Graine key-distribution group + its latest GroupInfo, for external join. **Members only** - the GroupInfo IS the capability. `groupInfo: null` means nobody has initialised the MLS group yet; `WORKSPACE_HAS_NO_DISTRIBUTION_GROUP` means there is no group at all |
| POST | `/api/channels/workspaces/:workspaceId/distribution-group/group-info` | Publish a committed GroupInfo (`{groupInfo, baseEpoch}`). Members only, monotonic - `{stored: false}` is a refused regression, not a failure |
| POST | `/api/channels/graine/live-sessions` | Of the Graine sessions the device holds (`{sessionIds}`, at most 500 - a longer list is REFUSED, never truncated), which are still named by a stored message: `{live, retentionDays}`. Scoped to the caller's communities. What keeps the seed retention window identical to the messages' one without a second clock; `retentionDays` travels back so the client holds no copy of it |
| GET | `/api/channels/invites/:token` | Preview a community invite |
| POST | `/api/channels/invites/:token/accept` | Join through an invite. Refuses a community with no members left (`WORKSPACE_HAS_NO_MEMBERS`) |
| POST | `/api/channels` | Create channel |
| POST | `/api/channels/:channelId/messages` | Send encrypted message |
| POST | `/api/channels/:channelId/members/join` | Join channel |
| POST | `/api/channels/:channelId/members/invite` | Invite user |
| POST | `/api/channels/:channelId/members/leave` | Leave a **private** channel (400 on a public one) |
| POST | `/api/channels/:channelId/messages/:messageId/pin` | Pin message |
| POST | `/api/channels/:channelId/messages/:messageId/reactions` | Toggle the caller's emoji reaction |

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
