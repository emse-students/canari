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

## ICE / TURN configuration

The SFU fetches short-lived TURN credentials from the Cloudflare Calls API on startup:

- `CLOUDFLARE_CALLS_API_TOKEN` — API token for Cloudflare
- `CLOUDFLARE_TURN_KEY_ID` — TURN key identifier
- `CLOUDFLARE_TURN_TTL_SECONDS` — Credential TTL (default: 3600)

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

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | yes | - | HS256 secret (shared with all services) |
| `CALL_ROOM_SECRET` | no | `""` | Secret for room access tokens (without it, room access control is disabled) |
| `PORT` | no | `3004` | Listen port |
| `CLOUDFLARE_CALLS_API_TOKEN` | no | - | Cloudflare API token for TURN credentials |
| `CLOUDFLARE_TURN_KEY_ID` | no | - | Cloudflare TURN key ID |
| `CLOUDFLARE_TURN_TTL_SECONDS` | no | `3600` | TURN credential TTL |
| `TURN_URL` | no | - | Static TURN URL (dev fallback) |
| `TURN_USERNAME` | no | `user` | Static TURN username |
| `TURN_CREDENTIAL` | no | `password` | Static TURN credential |

## See also

- [`chat-delivery-service` calls API](chat-delivery.md#calls) — room token issuance, ring signaling
- [`protocols/mls-protocol.md`](../protocols/mls-protocol.md) — MLS E2E encryption for call signaling
- [`frontend/modules/calls.md`](../frontend/modules/calls.md) — Call UI module
