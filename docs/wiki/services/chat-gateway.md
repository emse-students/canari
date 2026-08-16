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
    // "userId:deviceId" -> live senders keyed by conn_id (multiple tabs = multiple entries)
    pub connected_users: Arc<Mutex<HashMap<String, HashMap<u64, mpsc::Sender<String>>>>>,
    pub next_conn_id: AtomicU64,
    pub redis_client: Client,
    pub jwt_secret: String,
}
```

Each connection is assigned a unique `conn_id` from `next_conn_id` at registration, so a
connection can be removed by identity rather than by `is_closed()` - which has a race with an
aborted send task whose receiver the runtime has not dropped yet.

Two `AppState` methods own the whole "may I delete the presence key" decision, and are the only
readers of that invariant:

| Method | Question | Caller |
|---|---|---|
| `remove_session(conn_key, conn_id)` | unregister this connection; does another live session remain? | `ConnectionGuard::drop` |
| `has_other_sessions(conn_key, conn_id)` | without unregistering, does another live session remain? | `handle_disconnect` |

A `ConnectionGuard` is created per WebSocket connection. Its `Drop` impl calls `remove_session` and
deletes the Redis presence key only when nothing else holds it.

## WebSocket authentication

Token is extracted in this priority order:

1. Cookie `canari_ws_token`
2. Query parameter `token=`

If the JWT is invalid or absent, the connection is rejected with code `4401`.

## Connection lifecycle

1. HTTP upgrade to WebSocket.
2. JWT validation -> extract `userId`.
3. Register in `connected_users["userId:deviceId"]` (mpsc sender).
4. Set Redis `user:online:{userId}:{deviceId}` (TTL 20s).
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

Presence keys are stored in Redis as `user:online:{userId}:{deviceId}` with a 20-second TTL, refreshed on each WebSocket Pong. When delivery fails for a device and all senders are gone, the gateway proactively deletes the presence key so `chat-delivery-service` stops routing via pub/sub.

### The key is per DEVICE, the event is per CONNECTION

Two tabs of one browser share a `deviceId`, so they share one presence key while holding two
connections. Every path that deletes the key must therefore discount the connection it is acting
for and check whether any other one survives - the key answers "is this DEVICE online", never "is
this CONNECTION leaving".

Two paths delete it, and both ask that question through `AppState`:

- `ConnectionGuard::drop` - runs on every exit path, including cancellation and panic. Calls
  `remove_session`; on `true` it logs `[presence] Skipping DEL for {conn_key} - another session is
  still active` and returns.
- `handle_disconnect` - the app's own `{"type":"disconnect"}` frame, sent at `beforeunload` so
  peers see the user offline without waiting out the TTL. The sending connection is still
  registered at that moment, so it calls `has_other_sessions` and logs `[presence] Explicit
  disconnect from {conn_key} (conn_id=N) - skipping DEL, another session is still active`.

Until 2026-08-16 the second path deleted unconditionally, so a tab navigating away marked the whole
device offline; `drop` then ran, saw the survivor, and took the skip branch, so the guard written to
protect the key was exactly what stopped it being restored. Peers read the user offline until the
surviving socket's next `refresh_presence`. The decision is covered by five unit tests in
`state.rs` that need neither Redis nor a socket.

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
