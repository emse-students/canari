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

JWT HS256 validation against `JWT_SECRET`, and only an ACCESS token is accepted
(`decode_access_claims`): a token whose `type` claim is anything but `"access"` - the refresh token
says `"refresh"` - is refused, as in [chat-gateway](chat-gateway.md#websocket-authentication).

### Signal frames

All frames are JSON-encoded `SignalMessage`:

| Frame | Direction | Description |
|---|---|---|
| `Join { room_id, room_token, mode? }` | Client → Server | Join a room. `room_token` is a short-lived HS256 JWT issued by chat-delivery-service (`/api/calls/initiate`) proving group membership; always required (`CALL_ROOM_SECRET` is mandatory at boot). `mode` is `"p2p"` or `"sfu"`; absent means `"sfu"`. |
| `PeerReady { initiator }` | Server → Client | P2P only: both parties are in the room; `initiator` offers, the other is the polite side. Re-sent to the remaining peer when the other's device is replaced. |
| `PeerLeft` | Server → Client | P2P only: the other party's socket ended, or THIS device was replaced by a sibling. |
| `Refused { reason }` | Server → Client | The Join was refused: `room-full` (P2P, two other users hold it), `group-mismatch` (P2P, the token names another group than the seated peer's) or `mode-mismatch` (the room id exists in the other mode). |
| `Joined { room_id }` | Server → Client | Room join acknowledged; client is now ready to send `Offer`. |
| `Offer { sdp }` | Server → Client | Renegotiation offer when tracks are added to a room. |
| `Offer { sdp }` | Client → Server | Initial offer from the joining peer (first peer in room). |
| `Answer { sdp }` | Client → Server or Server → Client | SDP answer completing a negotiation. |
| `IceCandidate { candidate }` | Bidirectional | Trickle ICE candidates (JSON-encoded `RTCIceCandidateInit`). |
| `MicSuspended { suspended }` | Client → Server → partner | P2P only, relayed verbatim: the sender's operating system took (`true`) or gave back (`false`) its microphone - the capture track's `mute`, never the user's mute button. One relay line each, no ledger counter. Dropped with a line before `Join`, in an SFU room (`p2p-only frame ... in an SFU room`) and while the partner is away; a drop is never counted as `ice_in_failed`, which counts ICE alone. The partner has no other way to tell it from silence ([calls](../frontend/modules/calls.md#the-call-in-the-background-2026-10-19)). |

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

## Peer-to-peer mode (2026-10-17)

The 1:1 revival's server half (`src/p2p.rs`, wired in `main.rs`). A `mode: "p2p"` room opens **no
peer connection** - nothing in this mode touches webrtc-rs, TURN or a port - and only forwards
`Offer` / `Answer` / `IceCandidate` between its two peers, verbatim. Why, and the client half:
[calls lot 1](../frontend/modules/calls.md#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only).

- **Seats:** two users at most, one device each. A second device of a seated user REPLACES the
  first (the replaced one gets `PeerLeft`, its record `sibling-evicted`; the other party gets a new
  `PeerReady`). A third user gets `Refused { room-full }` and the room is left untouched - the
  capacity check runs before the eviction.
- **One group per room:** the room token's `group_id` claim (required since #1997) is stored on
  each seat, and a `Join` whose token names another group than the seated peer's gets `Refused {
  group-mismatch }` BEFORE any eviction - not seated, so never paired and never sent a candidate.
  chat-delivery binds the room id to its group at `initiate` and refuses a `room-token` for another
  group, so this is the second of two locks: knowing a room id buys nothing.
- **Nothing in this mode awaits a queue:** every frame - relayed, or the server's own `Joined`,
  `Refused`, `PeerReady`, `PeerLeft` - goes through `p2p::deliver` (`try_send`), so `p2p_join` and
  `p2p_leave` are synchronous. Awaiting room in another peer's bounded queue would let a peer that
  stopped reading freeze this one's socket task; awaiting this task's OWN queue would deadlock it.
  A full or closed queue drops the frame with a `p2p ... DROPPED` warning (and `ice_out_failed` on
  the partner's record for a candidate).
- **Size:** 64 KiB per message AND per frame (`MAX_SIGNAL_MESSAGE_BYTES`, both modes); either over
  ends the socket. The two caps are tested apart - one oversized frame, and an oversized message
  sent as small fragments, which only the message cap refuses. The largest legitimate frame is an
  SDP, a few KiB.
- **Roles:** arrival order, decided under the room's lock: the first in (the caller) is the
  initiator. Both ends are told in one `PeerReady` each.
- **Lifetime:** kept in `AppState.p2p_rooms`, apart from SFU rooms. The room is removed when its
  last SEAT goes (`DashMap::remove_if`, the same shard lock a racing `Join` takes). A room id lives
  in ONE mode; a `Join` in the other mode is `Refused { mode-mismatch }`.
- **A network blip is not a hangup (CALL-WIFI, 2026-10-19).** Measured on the Mi 9T: a 6 s and a
  14 s Wi-Fi outage each ended the call, because the socket's end freed the seat and told the
  partner `PeerLeft`. Now the record's FIRST disposition decides what a socket's end does:
  - `client-close` (a Close frame: a hangup) or `rate-limited` -> the seat is freed and the present
    partner gets `PeerLeft`, at once.
  - `transport-error`, `stream-ended`, `send-failed`, `keepalive-lost` (the network went) -> the
    seat stays, ABSENT, for `CALL_P2P_SEAT_GRACE_SEC` (default 60 s; the client's 15 attempts on a
    ladder capped at 4 s start their last at +55 s). The present partner gets `PeerAway`. Frames
    for an away partner are dropped with an `info` line (expected), not the `warn` of a lone peer.
  - **The keepalive is the liveness PROOF (2026-10-19).** Wi-Fi off on a phone leaves a HALF-OPEN
    socket: a ping write lands in the kernel buffer and "succeeds" for minutes, so no write error
    ever came - measured on the bench, the seat was never marked away, the partner's ICE restart
    offer was relayed into the dead socket, and after a 90 s outage the partner sat on
    "Reconnexion..." for good. Now a Ping goes out every 10 s (`CALL_KEEPALIVE_MS`) and ANY frame
    from the peer (a running browser answers every Ping with a Pong from its network stack) resets
    the count; two pings in a row unanswered (`MISSED_PONGS_LIMIT`) end the socket
    `keepalive-lost`, at most 30 s after the peer's last frame. A COUNT of ticks, so the partner of
    a device that never returns is told `PeerAway` within 30 s and `PeerLeft` within ~90 s. The
    loop's `select!` is `biased` with the socket read FIRST and the outbound queue (`Shutdown`)
    before the tick, so a Pong already readable is never counted missing and a socket whose seat
    was resumed is never accused; the interval is `MissedTickBehavior::Delay`, so a stalled loop
    does not fire its missed ticks back to back. **Every write the loop makes is bounded by one
    keepalive period** (`bounded_write`): a peer that stops READING fills the TCP window, and an
    unbounded write would park the loop - and its liveness tick - for as long as the kernel keeps
    the connection. A frame not taken in time ends the socket `send-failed`, a Ping
    `keepalive-lost`, each with a `... not taken within N ms - the peer reads nothing (TCP
    backpressure), held dead` line; both keep the p2p seat. Pinned by the unit test
    `a_write_the_peer_never_takes_ends_at_its_bound` (a write that never completes, so no clock
    decides it); an end-to-end backpressure test would race the keepalive itself, whichever fills
    first.
  - **A BEHAVIOUR CHANGE THIS BUYS, OWED A READING.** The Pong comes from a RUNNING process - a
    throttled background tab answers. A SUSPENDED one does not: an iOS or Android app the OS froze
    mid-call (screen locked, app backgrounded) now ends `keepalive-lost` 20-30 s in, and its
    partner gets `PeerLeft` ~60 s later; before, a suspended app's socket sat half-open and the
    seat stayed "present". Whether the bench phones stay running in a call with the screen locked
    is CALL-L1 row 11
    ([device-verification](../device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both));
    Android's background microphone is already CALL-LOCK-ANDROID.
  - **Resume:** every p2p `Joined` carries `resume_token`, a room token this service mints with the
    same `CALL_ROOM_SECRET` plus a `seat` claim (the peer id), valid 4 h (the longest call
    chat-delivery counts). A `Join` with it takes THAT seat back IN PLACE - same user and group
    only - so the roles never change. Both present parties then get `PeerReady { resumed: true }`
    (keep the peer connection, the initiator restarts ICE); an away partner gives the resumer
    `PeerAway`; a partner that hung up meanwhile gives it `PeerLeft`. A resume that finds no seat
    (expired, never this user's, room gone) is `Refused { call-over }` and never creates a room. If
    the server had not yet seen the old socket die, the resume replaces the live seat, the old
    record ends `resumed` (expected) and the old socket is CLOSED (an internal `Shutdown` its loop
    turns into a Close frame), so a half-open socket never lingers until the keepalive holds it
    dead.
  - `IceRestartRequest` (client -> partner) is relayed verbatim like an SDP: the polite side asks
    the initiator to restart ICE, since only the initiator offers. No counter, one relay line each.
  - **Grace end:** `[call] p2p seat EXPIRED room= peer=` at `warn`, the seat is freed, a present
    partner gets `PeerLeft`. The grace is a RESOURCE bound, never a verdict: a wrong value ends a
    dead call earlier or later, and a late resume is answered `call-over`.
  - A p2p `Join` whose token fails verification is now answered `Refused { token-refused }`
    instead of silence, so a client never waits out its Join timeout on a token that cannot pass.
- **Record:** `[call] session end room= peer= mode=p2p disposition= duration_ms= paired_ms= ...`
  with the usual counters, where `*_in` counts frames FROM this peer and `*_out` frames relayed TO
  it. `paired_ms` replaces `connected_ms`, because ICE runs between the clients and this service
  cannot see it - printing an ICE state would be a column answering a question it never measured.
  `paired_ms=-` means the other party never came. Plus `[call] p2p paired room= initiator= polite=`
  and one `[call] p2p offer|answer relayed` line per SDP (none per candidate).
- **Keepalive (both modes):** the socket loop sends a WebSocket Ping every 10 s (25 s until
  2026-10-19). A P2P call sends no signalling once connected, and production's host nginx closes a
  proxied socket after 60 s without a read from upstream (realtime-media-feasibility section 9,
  4a). Since 2026-10-19 it is also the liveness proof: two pings unanswered end the socket
  `keepalive-lost` (see the network-blip item above).
- **Pinned by** `src/p2p.rs` tests and `tests/p2p_signalling.rs`, which runs the real binary over
  real WebSockets with real room tokens. Each test starts the binary on `PORT=0` and reads the port
  it BOUND from its `Call service listening on <addr>` line (logged after `bind`, so it is also the
  readiness event). Picking a free port in the test and releasing it for the child to bind later
  let parallel tests collide: a readiness probe answered for another test's service, and a socket
  was reset under it (1 run in 30 failed that way, 0 in 90 since, 2026-10-18).

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

The SFU fetches short-lived TURN credentials from the Cloudflare Calls API **once per peer
connection** (`resolve_ice_servers()`, called from the `APIBuilder` path), not at startup - so a
process that has never had a caller logs nothing about ICE at all, and silence here means "no call
was placed", not "acquisition failed". Both are true of production today: calls are held off
(`CALLS_ENABLED`, see [calls module](../frontend/modules/calls.md)) and the container has logged one
line since it started. Two of the acquisition's own failure branches are silent, which is what makes
that ambiguity readable only from the source - [backlog P3](../backlog.md).

The credentials come from:

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
| `resumed` | p2p: the same device took its seat back on a new socket before this one was seen to die | info |
| `transport-error` | the socket errored mid-call — the network went away (p2p: the seat stays away for a resume) | warn |
| `stream-ended` | the stream ended with no `Close` frame — a client that died | warn |
| `rate-limited` | > 50 frames/s; the SFU disconnected it | warn |
| `send-failed` | the SFU could not write to this peer | warn |
| `room-reaped` | the room was still held when the 30-minute reaper ran | warn |
| `keepalive-lost` | the peer answered none of the last two keepalive pings — a half-open socket, the network gone (p2p: the seat stays away for a resume) | warn |
| `unknown` | no branch classified the ending — a hole in `main.rs`, not in the call | warn |

Only the first three are endings the design intends; everything else accuses. In p2p mode `transport-error`, `stream-ended`, `send-failed` and `keepalive-lost` keep the seat away for a resume ([peer-to-peer mode](#peer-to-peer-mode-2026-10-17)) - the record still accuses, because the network went.

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

## The end-to-end call in CI

**Decided by the owner on 2026-11-01 (D3):** the SFU is kept working for the day the School opens
UDP to it (D2, [group calls](../backlog.d/group-calls-p2p-mesh-up-to-4-audio-3-video-decided-2026-10-31.md)),
and what proves it works is a CALL, run in CI on every change that touches it - never a compile, and
never a by-hand session nobody repeats.

`apps/call-service/e2e/run.mjs` (bun) is that call. The CI job `test-call-service-e2e`
([cicd](../cicd.md#package-1-opening-a-pull-request-ciyml)) builds the binary, starts a throwaway
coturn on the runner's own address (`docker run --network host`, a fresh credential per run) and
runs:

```sh
bun apps/call-service/e2e/run.mjs --turn "turn:<ip>:3478?transport=udp" --turn-user e2e --turn-credential <pw>
bun apps/call-service/e2e/run.mjs                 # a dev box, no TURN: host candidates, ~15 s
```

| Part | What it is |
| --- | --- |
| The service | the crate's own binary on `PORT=0`, its port read from its `listening on` line; `JWT_SECRET` and `CALL_ROOM_SECRET` random per run, `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` set, Cloudflare's variables EMPTY - the env path is the one under test |
| The browsers | two headless Chromes (`tools/headless-chrome/chrome.mjs`, shared with the call audio rig) with Chrome's fake microphone, each with ONE peer connection - to the SFU - relay-only when a TURN server is given |
| The E2E transform | the app's `frontend/src/lib/workers/encryption.worker.ts`, BUILT FROM SOURCE, keyed per direction with crossed test keys; transforms assigned in the task that created the sender, and in `ontrack` for a transceiver the SFU's offer created ([the rule](../durable-rules.md#calls-and-their-record---call-service)) |
| The signalling | the service's real SFU protocol (`page.ts`): `Join { mode: "sfu" }`, `Joined`, the client's `Offer`, the SFU's `Answer`, the SFU's renegotiation `Offer` once the other participant publishes, trickled candidates both ways. The client has no SFU path since the 1:1 calls went peer to peer, so this page is the reference SFU client until WP-C11 writes the app's |
| Stand-ins | the keys (fixed bytes, not an MLS export), the tokens (minted by the driver with the service's secrets, not by chat-delivery-service), no ring |

**It passes only on proof** - each browser's worker DECRYPTED at least 250 audio frames under its
receive key, which is the other browser's send key, with no decrypt failure; the sender encrypted as
many; at least 250 inbound packets; with TURN, the selected candidate pair is `relay` on both
browsers and the SFU logged `SFU using TURN_URL env` (so it ran relay-only too). A frame that opens
was encrypted by the other participant and reached this one through the SFU, and through nothing
else. Then the SFU's own record: `ice connected` and an audio `track published` for both peers, and,
after both hang up, two `session end ... disposition=client-close` lines whose `connected_ms` is a
number.

**No clock decides it.** Every wait ends on a proof of success or of failure: the service or a
Chrome exiting, `Refused`, a signalling socket closing before the hangup, a peer connection
`failed`, the SFU's `ice Failed|Disconnected` for the room, a refused TURN allocation
(`icecandidateerror` under a relay-only policy with one server), a frame that does not decrypt. A
run in which NOTHING happens hangs, and the job's `timeout-minutes` is the only bound.

**What it covers that nothing did before:** a browser peer, DTLS-SRTP between Chrome and webrtc-rs
0.17, the SFU's forwarding loop carrying E2E-encrypted Opus untouched, the renegotiation path
(`schedule_renegotiate`: the first participant receives the second's track by an SFU offer -
`offer_out=1 answer_in=1` on its record), the ledger end to end, and a TURN relay on both legs.
**What it does not:** video and the PLI relay, Cloudflare's TURN (production's provider; the
School drops the UDP the SFU needs to reach it, [feasibility](../infrastructure/realtime-media-feasibility.md)),
a phone, more than two participants. First measured on a Windows dev box (Chrome 156, no TURN,
2026-11-01): PASS, ~250 frames each way decrypted, 0 failed.

**No upgrade was needed to make it work**: webrtc-rs 0.17 places the call. The 0.20 port stays a
separate decision ([calls](../frontend/modules/calls.md#the-webrtc-020-port-measured-2026-09-15)),
and this call is what any port would have to pass.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `JWT_SECRET` | yes | - | HS256 secret (shared with all services) |
| `CALL_ROOM_SECRET` | **yes** | - | Secret for room access tokens. Unset or empty, the service REFUSES TO START (it used to disable room access control; no dev flag exists, the local compose supplies a dev value) |
| `PORT` | no | `3004` | Listen port |
| `CALL_P2P_SEAT_GRACE_SEC` | no | `60` | How long a p2p seat whose socket dropped without a Close frame waits for its device to resume ([above](#peer-to-peer-mode-2026-10-17)). Not a number -> logged, default kept |
| `CALL_KEEPALIVE_MS` | no | `10000` | Keepalive ping period; two pings in a row unanswered end the socket `keepalive-lost` ([above](#peer-to-peer-mode-2026-10-17)). Set only by the integration tests. Not a positive number -> logged, default kept |
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
