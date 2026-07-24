# Architecture overview

## Service topology

Canari is a microservices monorepo. The only public entry point is **Nginx** (bundled in the `frontend` Docker image), which acts as a reverse proxy and authentication gateway via `auth_request`.

In production, Cloudflare Tunnel exposes `http://localhost:8080`, which forwards to Nginx on port 80 of the frontend container.

| Service | Stack | Port | Database | Role |
|---|---|---|---|---|
| **frontend** (Nginx) | Nginx + SvelteKit static | 80 | - | Single HTTP entry point, reverse proxy |
| **chat-gateway** | Rust / Axum / Tokio | 3000 | Redis | Real-time WebSocket, MLS routing, presence |
| **call-service** | Rust / Axum / webrtc-rs | 3004 | - | WebRTC SFU, Cloudflare TURN relay, keyframe recovery |
| **chat-delivery-service** | NestJS | 3010 | PostgreSQL + Redis | MLS API, offline queue, Redis Stream history |
| **media-service** | NestJS | 3011 | MinIO | E2EE encrypted blob storage |
| **core-service** | NestJS | 3012 | PostgreSQL | OIDC auth (Authentik), users, Stripe payments |
| **social-service** | NestJS | 3014 | PostgreSQL + MongoDB | Posts, forms, channels/communities, associations |
| Redis | - | 6379 | - | Presence, pub/sub, history streams |
| Kafka | Confluent 7.5 | 9092 / 29092 | - | Async event bus |
| PostgreSQL | - | 5432 | `auth_db` | Relational data |
| MongoDB | - | 27017 | `chat_db` | Posts and document data |
| MinIO | - | 9000 / 9001 | - | Media blobs (S3-compatible) |
| Coturn | - | 3478 / 5349 | - | STUN/TURN WebRTC (local dev only; production uses Cloudflare TURN) |

## Nginx routing

Nginx is the sole HTTP entry point. It authenticates every protected request via `auth_request /internal/auth/verify`, which calls `core-service:3012/api/auth/verify` internally. On success, Nginx injects headers `X-User-Id`, `X-Logged-In`, `X-Global-Admin` into the upstream request.

**Source of truth**: `infrastructure/local/Dockerfile.frontend`

| Public route | Upstream | Auth | Notes |
|---|---|---|---|
| `/api/ws` | `chat-gateway:3000` | yes | WebSocket upgrade, token cookie |
| `/api/presence` | `chat-gateway:3000` | yes | Online presence (Redis) |
| `/api/admin/presence` | `chat-gateway:3000` | yes | Admin presence view |
| `/api/mls/*` | `chat-delivery-service:3010` | yes | MLS API (messages, groups, sync, push); Redis history at `/api/mls/history/*` |
| `/api/chat-delivery-health` | `chat-delivery-service:3010` | no | Liveness probe only |
| `/api/media/*` | `media-service:3011` | yes | Encrypted blobs (MinIO) |
| `/api/posts/*` | `social-service:3014` | yes | News feed |
| `/api/forms/*` | `social-service:3014` | yes | Forms with payments |
| `/api/associations/*` | `social-service:3014` | yes | Clubs (Stripe Connect) |
| `/api/channels/*` | `social-service:3014` | yes | Workspaces and channels |
| `/api/auth/*` | `core-service:3012` | no | OIDC login, refresh, logout |
| `/api/users/*` | `core-service:3012` | yes | User profiles, search |
| `/api/payments/*` | `core-service:3012` | yes | Stripe (checkout, webhooks) |
| `/api/calls/ws` | `call-service:3004` | yes | WebRTC SFU WebSocket (call media relay) |

## Auth flow

### OIDC login (Authentik)

```
1. Frontend -> startOidcLogin()
     -> redirect to Authentik /authorize (PKCE, anti-CSRF state)

2. Authentik -> redirect to /auth/callback?code=...&state=...

3. Frontend -> POST /api/auth/oidc/callback { code, redirect_uri }
     -> core-service exchanges code for Authentik tokens (server-side)
     -> upsert user in PostgreSQL
     -> returns { access_token (JWT HS256, 15 min), refresh (HttpOnly cookie 7d) }

4. Frontend stores access_token in memory + sets cookie canari_ws_token
     (for WebSocket auth via cookie HTTP)

5. Automatic refresh: POST /api/auth/refresh via HttpOnly cookie
```

Dev only: `POST /api/auth/dev-login` (disabled via `ENABLE_DEV_ROUTES=false` in prod).

### Per-request auth (Nginx)

1. Browser sends request to Nginx.
2. Nginx calls `auth_request /internal/auth/verify` (internal only, never public).
3. `core-service` validates the JWT (HS256, 15-min TTL) from the `Authorization: Bearer` header or the `canari_ws_token` cookie (WebSocket).
4. On success: Nginx injects `X-User-Id`, `X-Logged-In`, `X-Global-Admin` and forwards to the upstream service.
5. On failure (401): Nginx returns 401 directly; the frontend redirects to login.

Access token lives in memory only (never localStorage). Refresh token is an HttpOnly cookie (7-day TTL).

## Inter-service communication

### Synchronous HTTP (internal Docker network, bypasses Nginx)

| Caller | Called | Purpose |
|---|---|---|
| chat-delivery-service | core-service | User verification |
| social-service | core-service | Payment auth, membership checks |
| media-service | - | Direct MinIO access via SDK |

### Redis pub/sub (real-time)

| Channel | Producer | Consumer | Payload |
|---|---|---|---|
| `chat:messages` | chat-delivery-service | chat-gateway | `{ recipientId, deviceId, proto (base64), groupId, senderId, … }` |
| `chat:channel_events` | social-service | chat-gateway | `{ type, data, userIds[], timestamp }` |

`chat:channel_events` types: `channel.member.joined`, `channel.member.kicked`, `channel.message.created`.

### Kafka (async events)

| Topic | Producer | Consumer | Payload type |
|---|---|---|---|
| `chat.messages` | chat-delivery-service | chat-delivery-service (push notif) | `MessageSentEvent` |
| `post_created` | social-service | chat-gateway | `PostCreatedEvent` |

## MLS message flow (online)

```
1. Sender (WASM): WasmMlsClient.send_message(groupId, plaintext)
   -> MLS ciphertext (AES-128-GCM, current epoch)

2. Frontend -> POST /api/mls/send
   { proto: base64(ciphertext), groupId, recipientId, deviceId }

3. chat-delivery-service:
   - Stores in Redis Stream history:{groupId}
   - Publishes N messages on Redis "chat:messages" (one per recipient device)

4. chat-gateway (subscribed to Redis "chat:messages"):
   - Lookup: connected_users["userId:deviceId"]
   - Online -> sends WS frame to recipient
   - Offline -> message stored, fetched on reconnect via GET /api/mls/messages/:userId/:deviceId

5. Recipient (WASM): processIncomingMessage(groupId, bytes) -> plaintext AppMessage -> UI
```

## MLS group creation flow

```
1. GET /api/mls/devices/:userId         -> device list / KeyPackages
2. POST /api/mls/groups { groupId, createdBy, members[], isGroup }
3. mls.createGroup(groupId)             -> epoch 0 (initiator side)
4. mls.addMembersBulk(devices)          -> { commit, welcome, ratchetTree }
5. POST /api/mls/welcome                -> offline storage per device
6. POST /api/mls/send (commit)          -> broadcast via Redis to online members
7. If multi-device (own devices): repeat steps 4-6
```

## WebSocket protocol frames

### Client -> gateway

| Frame | Fields | Action |
|---|---|---|
| `welcome_request` | `groupId`, `payload`, `targetUserId`, `targetDeviceId` | Forward Welcome to a peer |
| `reinvite_request` | same | Re-invite after stale epoch |
| `read` | `messageId` | Read receipt (no-op at gateway level) |

### Gateway -> client

```json
{
  "proto": "<base64 MLS ciphertext>",
  "senderId": "userId",
  "senderDeviceId": "deviceId",
  "groupId": "uuid",
  "isWelcome": false,
  "isCommit": false
}
```

## PostgreSQL schema overview

All tables share the `auth_db` database host. Full schemas are in the service wikis.

### core-service

| Table | Key columns |
|---|---|
| `users` | `id` (OIDC sub), `displayName`, `promo`, `formation`, `bio`, `stripeCustomerId`, `admin` |

### chat-delivery-service

| Table | Key columns |
|---|---|
| `key_packages` | `userId`, `deviceId` (UNIQUE), `packageBase64` |
| `one_time_key_packages` | pool of pre-keys per `(userId, deviceId)` |
| `queued_message` | `recipientId`, `deviceId`, `proto`, `isWelcome`, `isCommit`, `groupId`, `type`, `ratchetTree` |
| `dm_groups` | `id`, `isGroup`, `keyVersion`, `activeEpoch`, `latestKeyRotationPayload` |
| `dm_group_members` | `groupId`, `userId`, `role`, `leftAt` |
| `dm_device_group_memberships` | `groupId`, `userId`, `deviceId`, `status` (pending/welcome_sent/welcome_received/stale), `lastEpochSeen` |
| `push_tokens` | `userId`, `deviceId`, `token`, `platform` (fcm/apns) |

### social-service

| Table | Key columns |
|---|---|
| `channel_workspaces` | `id`, `slug` (unique), `name`, `createdBy`, `imageMediaId` |
| `channels` | `workspaceId`, `name`, `isPrivate`, `allowedRoles[]`, `keyVersion`, `masterSecret`, `archived` |
| `channel_roles` | `workspaceId`, `name`, `priority`, `permissions[]` |
| `channel_members` | `workspaceId`, `userId`, `roleIds[]`, `keys` (JSONB) |
| `channel_messages` | `channelId`, `senderId`, `content` (ciphertext), `nonce`, `keyVersion`, `replyTo`, `attachments`, `reactions` |
| `channel_key_distributions` | `channelId`, `userId`, `deviceId`, `status`, `attempts`, `sentAt`, `receivedAt`, `ackedAt` |

## Production deployment

```
Internet
  -> Cloudflare (TLS termination)
       -> Cloudflare Tunnel -> http://localhost:8080
            -> Nginx:80 (frontend container)
                 |- /api/ws         -> chat-gateway:3000
                 |- /api/calls/ws   -> call-service:3004
                 |- /api/mls/*      -> chat-delivery-service:3010
                 |- /api/media/*    -> media-service:3011
                 |- /api/auth/*     -> core-service:3012
                 |- /api/channels/* -> social-service:3014
                 `- /*              -> SvelteKit static (build/)
```

Backend services use `expose:` (not `ports:`) in production — only accessible within the Docker internal network.

## Key design decisions

- **Single Nginx entry point**: all services are private; only Nginx is exposed. This centralises auth and simplifies firewall rules.
- **MLS encryption in WASM**: all encryption/decryption happens client-side. The server stores only ciphertexts.
- **Media encryption**: client generates a CEK (AES-256-GCM) before upload; key travels in the MLS ciphertext. The media-service sees only opaque blobs.
- **At-least-once delivery**: Kafka consumer in chat-gateway commits offsets only after successful delivery attempts.
