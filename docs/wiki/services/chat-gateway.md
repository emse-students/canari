# chat-gateway

**Stack**: Rust / Axum / Tokio  
**Port**: 3000  
**Source**: `apps/chat-gateway/`

## Responsibilities

The chat-gateway is the real-time transport layer. It:

- Accepts WebSocket connections from clients and routes MLS frames to the correct recipient.
- Manages online presence in Redis.
- Broadcasts Kafka events (post creation) to all connected WebSocket clients.

It does **not** perform encryption, store messages, or make business logic decisions — those belong to `chat-delivery-service`.

## Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/ws` | yes (JWT cookie) | WebSocket upgrade |
| GET | `/api/presence` | yes | Online presence for a user |
| GET | `/api/admin/presence` | yes (global admin) | Admin view of all connected devices |
| GET | `/api/health` | no | Liveness probe |

Auth is enforced by Nginx `auth_request` before the request reaches the gateway.

## Internal state (`AppState`)

Shared across all handlers as `Arc<AppState>`:

```rust
pub struct AppState {
    // "userId:deviceId" -> list of mpsc senders (multiple tabs = multiple senders)
    pub connected_users: Arc<RwLock<HashMap<String, Vec<mpsc::Sender<String>>>>>,
    pub redis: Client,
    pub jwt_secret: String,
}
```

A `ConnectionGuard` is created per WebSocket connection. Its `Drop` impl removes the sender from `connected_users` and deletes the Redis presence key.

## WebSocket authentication

Token is extracted in this priority order:

1. Cookie `canari_ws_token`
2. Query parameter `token=`

If the JWT is invalid or absent, the connection is rejected with code `4401`.

## Connection lifecycle

1. HTTP upgrade to WebSocket.
2. JWT validation -> extract `userId`.
3. Register in `connected_users["userId:deviceId"]` (mpsc sender).
4. Set Redis `user:online:{userId}:{deviceId}` (TTL 90s).
5. Drain `pending_welcomes:{userId}` (Redis list of WS frames queued while offline).
6. Spawn `ws_read_loop` (client frames) and `ws_write_loop` (mpsc -> WS).

## WebSocket message routing

On each WebSocket connection, the gateway registers the user+device key (`userId:deviceId`) in the in-memory `connected_users` map (a `Mutex<HashMap<String, HashMap<String, Sender>>>`).

Two Redis channels are consumed:

### `chat:messages`

Published by `chat-delivery-service` when a message is queued for a specific device. Payload shape:

```json
{
  "recipientId": "user123",
  "deviceId": "dev456",
  "senderId": "…",
  "senderDeviceId": "…",
  "groupId": "…",
  "proto": "<base64-encoded MLS ciphertext or JSON notification>",
  "isWelcome": false,
  "isCommit": false,
  "isWelcomeRequest": false,
  "ratchetTree": null,
  "queuedMessageId": "…"
}
```

**Control frames** (`isWelcomeRequest: true`): the `proto` field contains a base64-encoded JSON notification (welcome invite). The gateway decodes it and relays as plain JSON text — no MLS envelope.

**MLS frames**: the gateway relays the full JSON as-is to the client's WebSocket channel.

If the target device is not connected, the message stays in the DB queue in `chat-delivery-service` and is fetched via `fetchPendingMessages` on reconnect — it is not lost.

### Welcome forward (`welcome_request` / `reinvite_request`)

When a client sends a `welcome_request` frame, the gateway:

1. Reads group members from Redis `group:members:{groupId}`.
2. For each target device found in `connected_users` -> sends via mpsc sender.
3. If the target device is offline -> stores the frame in Redis `pending_welcomes:{userId}` (LPUSH). Drained at next connection (step 5 of the lifecycle above).

### `chat:channel_events`

Published by `social-service` for channel membership changes, role updates, etc. Payload shape:

```json
{
  "userIds": ["user1", "user2"],
  "type": "channel_event",
  "data": { … }
}
```

The gateway fans out the frame to all connected devices of each listed user.

## Kafka consumer

Subscribes to the `post.created` topic (group `chat-gateway-broadcast`). On each message, it broadcasts a `{ type: "post_created", data: <post payload> }` frame to **all** connected WebSocket clients.

- Auto-commit disabled; offsets committed manually after delivery attempts (at-least-once).
- Offset is committed even if no clients are connected (to avoid replay storms after restarts).

## Presence

Presence keys are stored in Redis as `user:online:{userId}:{deviceId}` with a 90-second TTL, refreshed on each WebSocket Pong. When a connection closes cleanly, the key is deleted. When delivery fails for a device and all senders are gone, the gateway proactively deletes the presence key so `chat-delivery-service` stops routing via pub/sub.

## CORS

Configured via the `ALLOW_ORIGIN` environment variable:
- `*` — allow all origins (development)
- Comma-separated list — restrict to specific origins (production)

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | no | `redis://127.0.0.1/` | Redis connection string |
| `JWT_SECRET` | yes | - | HS256 JWT secret (shared with core-service) |
| `KAFKA_BROKERS` | no | `localhost:9092` | Kafka broker list |
| `ALLOW_ORIGIN` | no | `*` | CORS allowed origins |
| `RUST_LOG` | no | `chat_gateway=debug,tower_http=debug` | Log filter |
