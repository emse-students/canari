# call-service

**Stack**: Rust / Axum / webrtc-rs  
**Port**: 3004  
**Source**: `apps/call-service/`

## Responsibilities

The call-service is a **Selective Forwarding Unit (SFU)** for WebRTC calls. It:

- Accepts WebSocket connections from call participants.
- Validates room access via short-lived tokens issued by [`chat-delivery-service`](chat-delivery.md).
- Forwards encrypted RTP streams between peers in a room (one peer per user, sibling eviction).
- Relies on Cloudflare TURN for NAT traversal — the SFU itself is relay-only.
- Provides on-demand and periodic keyframe recovery for video tracks.

The SFU does **not** decrypt media: RTP packets are forwarded opaquely (E2E encryption happens at the browser/MLS layer). It cannot read audio/video content.

## Architecture

```
Browser / Native App
      |
      | WebSocket (wss://)
      v
call-service:3004 (Rust/Axum)
      |
      | JWT auth (canari_ws_token)
      | Room token validation (CALL_ROOM_SECRET)
      v
DashMap<RoomId, Arc<Room>>
      |
      +-- Room.peers: DashMap<PeerId, PeerContext>
      |       each PeerContext wraps an RTCPeerConnection (webrtc-rs)
      |
      +-- Room.tracks: Vec<PublishedTrack>
              |-- per-track RTP forwarding loop (tokio::spawn)
              |-- PLI/FIR relay for keyframe recovery
              `-- periodic recovery timer (3 s, coalesced)
```

## WebSocket protocol

### Auth

Token extraction order (same pattern as [`chat-gateway`](chat-gateway.md)):

1. Cookie `canari_ws_token`
2. Query parameter `token=` (Tauri mobile fallback)

JWT HS256 validation against `JWT_SECRET`.

### Signal frames

All frames are JSON-encoded `SignalMessage`:

| Frame | Direction | Description |
|---|---|---|
| `Join { room_id, room_token }` | Client → Server | Join a room. `room_token` is a short-lived HS256 JWT issued by chat-delivery-service (`/api/calls/initiate`) proving group membership. Required when `CALL_ROOM_SECRET` is set. |
| `Joined { room_id }` | Server → Client | Room join acknowledged; client is now ready to send `Offer`. |
| `Offer { sdp }` | Server → Client | Renegotiation offer when tracks are added to a room. |
| `Offer { sdp }` | Client → Server | Initial offer from the joining peer (first peer in room). |
| `Answer { sdp }` | Client → Server or Server → Client | SDP answer completing a negotiation. |
| `IceCandidate { candidate }` | Bidirectional | Trickle ICE candidates (JSON-encoded `RTCIceCandidateInit`). |

### Room join flow

```
1. Client connects WebSocket
2. JWT validation → user_id
3. Client sends Join { room_id, room_token }
4. Server validates room_token:
   - room_id matches
   - sub matches user_id
   - HS256 signature valid (CALL_ROOM_SECRET)
5. Server evicts sibling peers (one SFU participant per user)
6. Server creates RTCPeerConnection (webrtc-rs)
7. Server subscribes new peer to existing room tracks
8. For each existing video track → request keyframe burst
9. Server sends Joined { room_id }
10. Peer sends Offer → Server answers → ICE → media flows
```

## Room lifecycle

- Rooms are created on first `Join` and evicted when the last peer leaves.
- Stale rooms (no signal activity > 30 minutes) are cleaned up by a background tokio task (every 5 minutes).
- **Every path that drops a peer calls `RTCPeerConnection::close()` first** — the ordinary hangup,
  sibling eviction and the stale-room reaper alike. webrtc-rs holds the ICE agent and its TURN
  allocation until told to let go, and a relay allocation left running is billed against the same
  monthly budget [`getIceServers`](chat-delivery.md#calls) refuses credentials to protect. It is
  also what makes the session record below true: a `session end` line emitted while the allocation
  is still live states an end that has not happened.

## ICE / TURN configuration

The SFU fetches short-lived TURN credentials from the Cloudflare Calls API on startup:

- `CLOUDFLARE_CALLS_API_TOKEN` — API token for Cloudflare
- `CLOUDFLARE_TURN_KEY_ID` — TURN key identifier
- `CLOUDFLARE_TURN_TTL_SECONDS` — Credential TTL (default: 7200)

If Cloudflare is not configured, it falls back to `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` env vars (dev only). Without any TURN configuration, falls back to Google STUN only.

The SFU filters out TURN URLs incompatible with webrtc-rs (TCP, TLS, port 53, 80, 443) — only TURN/UDP is usable.

## Video keyframe recovery

Since the SFU forwards opaque E2E-encrypted RTP, it cannot detect when subscribers need a keyframe. Two mechanisms compensate:

### On-demand PLI forwarding

When a subscriber's browser sends RTCP PLI/FIR (unencrypted feedback), the SFU relays it to the publisher. This covers:
- Late joiners (missed the last keyframe)
- Packet loss on the subscriber's path

### Periodic recovery timer

A slow 3-second timer nudges one PLI per video track *only when no on-demand PLI was relayed recently* (coalesced via `last_pli` timestamp). This bounds freeze duration when a relayed PLI is itself lost on a lossy TURN path.

## Renegotiation

When a new track arrives, all existing peers must be renegotiated. `schedule_renegotiate` uses a per-peer generation counter to debounce multiple simultaneous track additions (audio + video = one offer), waiting 300 ms before sending the offer.

## Rate limiting

Max 50 signal frames per second per peer. Exceeded peers are disconnected.

## The call record

A call failure is seen in halves. The caller's client knows it sent an offer; the callee's client
knows it never rang. Neither log can say which of the two halves failed, because neither side sees
the other. **The SFU is the only witness that sees both**, so it keeps a per-socket ledger
(`CallLedger`) and emits it as one line when the socket ends. The record exists for attribution,
not for observability: its job is to separate causes that otherwise look identical.

### The join key

`chat-delivery-service` mints the room id in `POST /api/calls/initiate`, and the client assigns it
to `currentCallId` unchanged (`frontend/src/lib/services/CallService.ts`). **`callId` and `roomId`
are the same value**, which is the only thing joining the ring fan-out's `[ring] call=<uuid>` lines
to the SFU's `room=<uuid>` lines. Nothing else links the two services' halves of a call, so that
identity must not become two values.

### The lines

| Line | When | Reads |
|---|---|---|
| `[call] invite room= user= group=` | `/api/calls/initiate` (chat-delivery) | the caller asked for a room |
| `[ring] call= group= rang=N/M devices` | ring fan-out (chat-delivery) | how many devices were actually pushed |
| `[call] join-token room= user= group=` | `/api/calls/room-token` (chat-delivery) | a callee is about to join the SFU |
| `[call] socket open peer=` | WS upgrade accepted | authenticated, not yet in a room |
| `[call] session start room= peer=` | `Join` accepted | the ledger begins here |
| `[call] track published room= peer= kind=` | `on_track` | this peer's media reached the SFU |
| `[call] ice connected room= peer= after_ms= …` | first `Connected`/`Completed` | media path formed, and how long it took |
| `[call] ice Failed\|Disconnected room= peer= connected_ms= …` | terminal ICE state | negotiation gave up; carries the counts |
| `[call] session end room= peer= disposition= …` | socket closed | **the record** |

`peer` is `{user_id}:{uuid}` — one socket, not one user, so a user's two devices are two records.

### Disposition — why the session ended

Set **once, first cause wins**. An evicted device sends a `Close` frame moments later and a reaped
room's socket errors out afterwards; recording the last event would report the consequence and hide
the cause. The tokens are a contract the campaign greps on, pinned by
`disposition_tokens_are_stable`:

| Token | Meaning | Level |
|---|---|---|
| `client-close` | the client sent a `Close` frame — a hangup | info |
| `sibling-evicted` | the same user joined from another device; this one was replaced | info |
| `transport-error` | the socket errored mid-call — the network went away | warn |
| `stream-ended` | the stream ended with no `Close` frame — a client that died | warn |
| `rate-limited` | > 50 frames/s; the SFU disconnected it | warn |
| `send-failed` | the SFU could not write to this peer | warn |
| `room-reaped` | the room was still held when the 30-minute reaper ran | warn |
| `unknown` | no branch classified the ending — a hole in `main.rs`, not in the call | warn |

Only the first two are endings the design intends; everything else accuses.

### The fields that separate the causes

```
[call] session end room=<uuid> peer=<user>:<dev> disposition=transport-error duration_ms=41230 \
  connected_ms=38104 ice_state=Failed offer_in=1 answer_out=1 offer_out=2 answer_in=2 \
  ice_in=14 ice_buffered=3 ice_in_failed=0 ice_out=11 ice_out_failed=0 tracks_pub=2 tracks_sub=2
```

- **`duration_ms` next to `connected_ms`** is the pair that answers "was the call short, or did it
  never happen". `connected_ms=-` means media never flowed at all — it is rendered as a dash rather
  than a zero precisely so it cannot be read as a very short call.
- **`offer_in` / `answer_out` / `offer_out` / `answer_in`** say *which side sent* and *which side
  never arrived*. A peer with `offer_in=1 answer_out=0` was answered by nobody; `offer_out=3
  answer_in=0` is a client that ignored renegotiation.
- **`ice_in` vs `ice_out`** separate a TURN fault from a client that never trickled: candidates
  gathered on both sides with no pair formed is the former, `ice_in=0` is the latter. They look
  identical without the counts, which is why the terminal ICE line carries them too — built out of
  the same helper as the record so the two cannot disagree.
- **`ice_buffered`** counts candidates that arrived before the offer was applied (normal trickle
  ordering); `ice_in_failed` counts ones that were rejected.

### What is deliberately not logged

**No line per ICE candidate.** A call gathers dozens, on every socket, and a per-candidate line at
info level would bury the eight lines that answer a question. The count at the end of negotiation is
the figure; the trickle is not. Likewise, no log line carries an SDP blob or a candidate string —
`SignalMessage::kind()` exists so a line can name the frame without its payload.

`resolve_peer` also stays **silent when the disposition is already set**: an evicted device keeps
trickling ICE for a second or two, and warning about a peer whose absence is already recorded is
noise about a cause already named.

### Pinned by

`apps/call-service/src/main.rs` `#[cfg(test)] mod tests` (10 tests) for the ledger and the token
contract, and `apps/chat-delivery-service/src/services/calls.service.spec.ts`
(`the server-side call record`) for the invite half. Neither asserts a wall clock — only whether a
duration is present or absent.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | yes | - | HS256 secret (shared with all services) |
| `CALL_ROOM_SECRET` | no | `""` | Secret for room access tokens (without it, room access control is disabled) |
| `PORT` | no | `3004` | Listen port |
| `CLOUDFLARE_CALLS_API_TOKEN` | no | - | Cloudflare API token for TURN credentials |
| `CLOUDFLARE_TURN_KEY_ID` | no | - | Cloudflare TURN key ID |
| `CLOUDFLARE_TURN_TTL_SECONDS` | no | `7200` | TURN credential TTL |
| `TURN_URL` | no | - | Static TURN URL (dev fallback) |
| `TURN_USERNAME` | no | `user` | Static TURN username |
| `TURN_CREDENTIAL` | no | `password` | Static TURN credential |

## See also

- [`chat-delivery-service` calls API](chat-delivery.md#calls) — room token issuance, ring signaling
- [`protocols/mls-protocol.md`](../protocols/mls-protocol.md) — MLS E2E encryption for call signaling
- [`frontend/modules/calls.md`](../frontend/modules/calls.md) — Call UI module
