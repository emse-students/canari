# Shared libraries

**Source**: `libs/`

Canari shares types and event definitions across services via two libraries in the monorepo.

## libs/shared-rust

**Stack**: Rust  
**Source**: `libs/shared-rust/Cargo.toml`

**THIS CRATE IS DEAD AS OF 2026-08-31 AND SHOULD BE DELETED.** It defines Kafka event structs and
topic constants for a broker that no longer exists. `apps/chat-gateway/Cargo.toml` names it as a
path dependency and its source contains no `shared_rust` at all; no TypeScript imports the generated
bindings either. Nothing in this repository reads a line of it.

`ts-rs` mirrors each struct into TypeScript so a future TS consumer cannot drift from the Rust
definition.

### Event types

| Struct | Topic constant | Where that topic name appears outside this crate |
|---|---|---|
| `MessageSentEvent` | `TOPIC_CHAT_MESSAGES` (`chat_messages`) | nowhere |
| `MessageReadEvent` | `TOPIC_MESSAGE_READ` (`message_read`) | nowhere |
| `PostCreatedEvent` | `TOPIC_POST_CREATED` (`post_created`) | nowhere, since 2026-08-31 |

That third column is MEASURED, not intended, and it says these structs describe a contract nothing
in the system speaks. An earlier version of this table named a producer and a consumer for all
three; none of those routes has ever existed in the repo.

**The one consumer that did exist never used the constant, nor even its spelling.** `subscribers.rs`
subscribed to `post.created` while `TOPIC_POST_CREATED` is `post_created`, so a producer written
against this crate would have published to a topic that consumer never read - the two agreeing on a
struct and disagreeing on a name. It went with the broker; see
[chat-gateway](services/chat-gateway.md#no-kafka-consumer-and-no-broker---removed-2026-08-31).

### The TypeScript mirror

`cargo test` regenerates `libs/shared-rust/bindings/*.ts` through `ts-rs`, and those files are
COMMITTED. That is the whole mechanism: change a struct, run the tests, and the drift shows up as a
dirty working tree in the same commit as the Rust change. Nothing imports them today - they exist so
the contract is written down in both languages, generated from one source.

Until 2026-08-27 they were written into `libs/shared-ts/src/types/` instead. That package is deleted;
see the note at the end of this page.

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
cd frontend
bun run proto:gen
```

Generates `frontend/src/lib/proto/canari.{js,d.ts}` from `canari.proto` with `pbjs`/`pbts`. Those two
files are GENERATED and not in git; `bun run generate` builds them alongside the MLS WASM bundle.

---

## See also

- [`protocols/websocket-protocol.md`](protocols/websocket-protocol.md) — Full binary protocol specification
- [`architecture.md`](architecture.md) — Kafka topic usage in context
- [`protocols/mls-protocol.md`](protocols/mls-protocol.md) — How `AppMessage` fits into MLS encryption

---

## libs/shared-ts, deleted 2026-08-27

There was a third library, `@canari/shared-ts`. It exported three Kafka topic names, a Redis envelope
builder, and re-exports of the three `ts-rs` types. **Nothing imported it** - not one `src/` file in
any of the four NestJS services, not the frontend. Its only mention outside its own directory was a
Jest `moduleNameMapper` in `chat-delivery-service` pointing at the library's SOURCE, which no test
ever resolved, plus a build stage in that service's Dockerfile that compiled it and copied the output
nowhere. Its only commits in its last year were version bumps.

It cost more than it looks: a CI matrix entry, a build step before EVERY backend test job, two CD
path filters, a Dependabot directory, a Makefile target, two Husky branches and a lockfile.

The two things it would have been useful for are duplicated on purpose instead, with the reason
written at the head of each copy: `internal/service-urls.ts` and `internal-secret.util.ts`, in
`core-service` and `social-service`. That trade is still the right one - a shared package would add a
build stage to two more production images to save four lines each. A THIRD copy is the signal to
reconsider, and recreating the package is a twenty-minute job.
