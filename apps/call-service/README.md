# Call Service

Rust Selective Forwarding Unit (SFU) for WebRTC calls. Runs on port **3004**.

## Responsibilities

The call-service forwards encrypted RTP streams between peers in a room:

- Accepts WebSocket connections from call participants.
- Validates room access via short-lived tokens issued by chat-delivery-service.
- Forwards encrypted RTP streams between peers (one peer per user, sibling eviction).
- Relies on Cloudflare TURN for NAT traversal - the SFU itself is relay-only.
- Provides on-demand and periodic keyframe recovery for video tracks (PLI/FIR relay and 3-second coalesce timer).

The SFU does **not** decrypt media: RTP packets are forwarded opaquely. E2E encryption happens at the browser/MLS layer.

## WebSocket Protocol

Clients authenticate via JWT (`canari_ws_token` cookie or `token=` query parameter) and exchange JSON-encoded `SignalMessage` frames:

| Frame | Direction | Description |
|---|---|---|
| `Join { room_id, room_token }` | Client -> Server | Room join with short-lived access token from chat-delivery. |
| `Joined { room_id }` | Server -> Client | Acknowledgment; client ready to send `Offer`. |
| `Offer { sdp }` | Bidirectional | SDP renegotiation offer (sent by server when tracks arrive, by client on join). |
| `Answer { sdp }` | Bidirectional | SDP answer completing negotiation. |
| `IceCandidate { candidate }` | Bidirectional | Trickle ICE candidates. |

## Room Lifecycle

- Rooms are created on first `Join` and destroyed when the last peer leaves.
- Stale rooms (no signal activity > 30 minutes) are cleaned up by a background task every 5 minutes.
- Renegotiation is debounced per-peer (300 ms) to coalesce multiple track additions (audio + video = one offer).

## ICE / TURN Configuration

The SFU fetches short-lived TURN credentials from Cloudflare Calls API on startup, or falls back to static `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` for development.

## Startup

```bash
cd apps/call-service
cargo run --release
```

Requires Cloudflare or static TURN configuration. The SFU holds its rooms in process memory and has
no database or Redis dependency of its own.

## Environment Variables

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

- [Wiki: call-service](../../docs/wiki/services/call-service.md) - Full architecture and keyframe recovery mechanism
- [Wiki: calls module](../../docs/wiki/frontend/modules/calls.md) - Client-side call UI
