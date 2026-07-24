# Shared libraries

**Source**: `libs/`

Canari shares types and event definitions across services via three libraries in the monorepo.

## libs/shared-rust

**Stack**: Rust  
**Source**: `libs/shared-rust/Cargo.toml`

Defines canonical event structs shared between Rust services (`chat-gateway`, `call-service`) and TypeScript services (via `ts-rs` auto-generated TypeScript types).

### Event types

| Struct | Kafka topic | Producer | Consumer |
|---|---|---|---|
| `MessageSentEvent` | `chat.messages` | chat-delivery-service | chat-delivery-service (push notifications) |
| `MessageReadEvent` | `message_read` | — | — |
| `PostCreatedEvent` | `post_created` | social-service | chat-gateway (WS broadcast) |

`ts-rs` auto-exports TypeScript equivalents to `libs/shared-ts/src/types/`.

### Key fields

```rust
pub struct MessageSentEvent {
    pub id: Uuid,
    pub sender_id: String,
    pub username: String,
    pub content: String,
    pub timestamp: DateTime<Utc>,
    pub conversation_id: Option<String>,
}

pub struct PostCreatedEvent {
    pub id: Uuid,
    pub author_id: String,
    pub content: String,
    pub media_urls: Vec<String>,
    pub timestamp: DateTime<Utc>,
}
```

### Topic constants

| Constant | Value |
|---|---|
| `TOPIC_CHAT_MESSAGES` | `"chat_messages"` |
| `TOPIC_MESSAGE_READ` | `"message_read"` |
| `TOPIC_POST_CREATED` | `"post_created"` |

---

## libs/shared-ts

**Stack**: TypeScript  
**Source**: `libs/shared-ts/`

Shared TypeScript package consumed by NestJS backend services (`chat-delivery-service`, `social-service`, `core-service`, `media-service`).

### Exports

| Module | Contents |
|---|---|
| `events/chat.events.ts` | `ChatEvents` enum, event type constants |
| `proto/inbound.ts` | Protobuf-generated TypeScript types (`InboundMsg`, `WsEnvelope`, etc.) |
| `types/MessageSentEvent.ts` | Auto-generated from shared-rust |
| `types/MessageReadEvent.ts` | Auto-generated from shared-rust |
| `types/PostCreatedEvent.ts` | Auto-generated from shared-rust |

---

## libs/proto

**Source**: `libs/proto/canari.proto`

The canonical protobuf schema for Canari's WebSocket transport and application message payload. See [`protocols/websocket-protocol.md`](protocols/websocket-protocol.md) for the full wire format.

### Schema sections

| Section | Messages | Purpose |
|---|---|---|
| Transport envelope | `WsEnvelope`, `InboundMsg`, `Recipient` | Client ↔ Gateway binary frames |
| Application payload | `AppMessage`, `TextMsg`, `ReplyMsg`, `ReactionMsg`, `MediaMsg`, `SystemMsg` | E2E-encrypted plaintext inside MLS ciphertext |

### Code generation

```bash
cd libs/shared-ts
npm run proto:gen
```

Generates TypeScript types from `canari.proto` into `libs/shared-ts/src/proto/inbound.ts`.

---

## See also

- [`protocols/websocket-protocol.md`](protocols/websocket-protocol.md) — Full binary protocol specification
- [`architecture.md`](architecture.md) — Kafka topic usage in context
- [`protocols/mls-protocol.md`](protocols/mls-protocol.md) — How `AppMessage` fits into MLS encryption
