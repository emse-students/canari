# WebSocket binary protocol

**Source**: `libs/proto/canari.proto`

All client ↔ gateway WebSocket frames use **Protobuf v3 binary encoding**, not JSON. This page documents the wire format defined in [`canari.proto`](../../libs/proto/canari.proto).

## Transport envelope

### Client → Gateway

Every outgoing frame is wrapped in `WsEnvelope`:

```protobuf
message WsEnvelope {
  oneof body {
    MlsFrame     mls     = 1;  // application message or MLS commit
    WelcomeFrame welcome = 2;  // MLS Welcome (group invite)
    ReadAck      read    = 3;  // read receipt
  }
}
```

### Gateway → Client

The gateway sends `InboundMsg` directly (no outer envelope):

```protobuf
message InboundMsg {
  bytes  ciphertext       = 1; // raw MLS bytes
  string sender_id        = 2;
  string sender_device_id = 3;
  string group_id         = 4;
  bool   is_welcome       = 5; // process as MLS Welcome
  bool   is_commit        = 6; // MLS structural commit
}
```

## Frame types

### MlsFrame — application message or commit

```protobuf
message MlsFrame {
  bytes             ciphertext = 1; // raw MLS ciphertext bytes
  string            group_id   = 2;
  repeated Recipient recipients = 3; // empty = derive from group members
}

message Recipient {
  string user_id   = 1;
  string device_id = 2; // empty = fan-out to all devices
}
```

Used for: text messages, media messages, reactions, edits, deletes, MLS commits (add/remove member). The `ciphertext` is the output of `WasmMlsClient.send_message()` — the `AppMessage` proto is serialized, encrypted by MLS, and the resulting ciphertext goes here.

### WelcomeFrame — group invite

```protobuf
message WelcomeFrame {
  bytes             ciphertext = 1; // MLS Welcome bytes
  string            group_id   = 2;
  repeated Recipient recipients = 3;
}
```

Used when inviting devices to a newly created or re-keyed group. The `ciphertext` is the MLS Welcome message (contains the group secrets encrypted to the new member's key package).

### ReadAck — read receipt

```protobuf
message ReadAck {
  string message_id = 1; // UUID string of the acknowledged message
}
```

Sent when a user reads a message. The gateway routes this to the sender's connected devices.

## Application payload (inside MLS)

The `AppMessage` is what gets encrypted by MLS and placed inside `MlsFrame.ciphertext`. The server never sees it in plaintext.

```protobuf
message AppMessage {
  string message_id = 6;   // sender-assigned UUID
  int64  sent_at    = 8;   // client timestamp (ms since epoch)
  oneof kind {
    TextMsg     text     = 1;
    ReplyMsg    reply    = 2;
    ReactionMsg reaction = 3;
    MediaMsg    media    = 4;
    SystemMsg   system   = 5;
  }
}
```

### Message kinds

| Kind | Proto message | Use |
|---|---|---|
| `text` | `TextMsg { content }` | Plain text chat message |
| `reply` | `ReplyMsg { target_message_id, content, kind }` | Reply to another message |
| `reaction` | `ReactionMsg { target_message_id, emoji }` | Emoji reaction |
| `media` | `MediaMsg { media_id, file_name, mime_type, cek, iv, media_kind }` | Encrypted media attachment. CEK + IV are inside the MLS ciphertext; the media-service stores only opaque ciphertext. |
| `system` | `SystemMsg { event, data }` | System events: `read_receipt`, `call_invite`, `call_answered`, `call_hangup`, `group_reset`, etc. |

### MediaMsg encryption

```
Browser:
  1. Generate random CEK (AES-256-GCM)
  2. Encrypt file with CEK + IV
  3. Upload ciphertext → media-service → returns mediaId
  4. Build AppMessage { media: { mediaId, fileName, mimeType, cek, iv, mediaKind } }
  5. Encrypt AppMessage via MLS → send as MlsFrame
```

The recipient decrypts the MLS ciphertext → extracts CEK + IV → fetches ciphertext from media-service → decrypts locally.

## Gateway-side handling

The [`chat-gateway`](../services/chat-gateway.md) server processes `WsEnvelope` frames:

| Body variant | Action |
|---|---|
| `mls` (with recipients) | Fan out `InboundMsg` to each recipient device via Redis pub/sub or direct WS send |
| `mls` (no recipients) | Look up group members from Redis `group:members:{groupId}` → fan out |
| `welcome` | Deliver Welcome to target devices; offline devices get it queued in `pending_welcomes:{userId}` |
| `read` | No-op at gateway level (read receipts are handled by chat-delivery-service directly) |

## See also

- [`mls-protocol.md`](mls-protocol.md) — MLS encryption flow, how AppMessage becomes ciphertext
- [`services/chat-gateway.md`](../services/chat-gateway.md) — Gateway WebSocket routing
- [`services/chat-delivery.md`](../services/chat-delivery.md) — Message persistence and offline delivery
