# Chat Gateway

Rust Axum WebSocket server for real-time message transport. Runs on port **3000**.

## Responsibilities

The chat-gateway is the real-time transport layer. It:

- Accepts WebSocket connections from clients and routes MLS frames to the correct recipient.
- Manages online presence in Redis (`user:online:{userId}:{deviceId}`, 20-second TTL).
- Relays welcome requests to online group members; queues them in Redis for offline targets.

It does **not** perform encryption, store messages, or make business logic decisions - those belong to `chat-delivery-service`.

## Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/ws` | yes (JWT cookie) | WebSocket upgrade |
| GET | `/api/presence` | yes | Online presence for a user |
| GET | `/api/admin/presence` | yes (global admin) | Admin view of all connected devices |
| GET | `/api/health` | no | Liveness probe |

Auth is enforced by Nginx `auth_request` before the request reaches the gateway.

## WebSocket Message Routing

### `chat:messages` - MLS and notification frames

Published by `chat-delivery-service` when a message is queued for a specific device. Frames are either:

- **MLS messages**: relayed as-is to the client's WebSocket channel.
- **Control frames** (`isWelcomeRequest: true`): JSON notification decoded and relayed as plain text.

If the target device is not connected, the message stays in the database queue and is fetched on reconnect.

### `chat:channel_events` - Channel membership and role changes

Published by `social-service` for workspace and channel updates. The gateway fans out each frame to all connected devices of affected users.

### No Kafka consumer, and no broker - removed 2026-08-31

This service consumed `post.created` and rebroadcast every record to all connected sockets. Nothing
ever produced the topic, the shared constant spelled it `post_created` while the subscription used
`post.created`, and the client had no branch for the frame. The consumer, `rdkafka` and the
`kafka` + `zookeeper` containers went together. Full reasoning in
[the wiki](../../docs/wiki/services/chat-gateway.md#no-kafka-consumer-and-no-broker---removed-2026-08-31).

## Connection Lifecycle

1. HTTP upgrade to WebSocket.
2. JWT validation (cookie or query param `token=`) -> extract `userId:deviceId`.
3. Register in in-memory `connected_users` map (mpsc sender).
4. Set Redis presence key (TTL 20s).
5. Drain `pending_welcomes:{userId}` (queued frames from offline period).
6. Spawn read/write loops.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | no | `redis://127.0.0.1/` | Redis connection string |
| `JWT_SECRET` | yes | - | HS256 JWT secret (shared with core-service) |
| `ALLOW_ORIGIN` | no | `*` | CORS allowed origins (comma-separated list for production) |
| `RUST_LOG` | no | `chat_gateway=debug,tower_http=debug` | Log filter |

## Startup

```bash
cd apps/chat-gateway
cargo run --release
```

Requires a running Redis instance.

## See also

- [Wiki: chat-gateway](../../docs/wiki/services/chat-gateway.md) - Full connection lifecycle and message routing
- [Wiki: Architecture](../../docs/wiki/architecture.md) - Service topology and Nginx routing
