# chat-gateway

**Stack**: Rust / Axum / Tokio  
**Port**: 3000  
**Source**: `apps/chat-gateway/`

## Responsibilities

The chat-gateway is the real-time transport layer. It:

- Accepts WebSocket connections from clients and routes MLS frames to the correct recipient.
- Manages online presence in Redis.

It does **not** perform encryption, store messages, or make business logic decisions — those belong to `chat-delivery-service`.

## Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/ws` | yes (JWT cookie) | WebSocket upgrade |
| POST | `/api/presence` | yes | Online presence of the asked users (`{ users: [...] }`, at most 1000) the caller may see ([audience](#who-may-see-whose-presence-wp-presence-2026-10-18), [why a body](#the-ids-travel-in-a-body-never-in-the-url-2026-10-28)) |
| GET | `/api/presence?users=` | yes | LEGACY, the same answer for clients installed before the POST ([legacy-compatibility](../legacy-compatibility.md#no-date-yet---the-presence-ids-in-a-url)) |
| GET | `/api/admin/presence` | yes (global admin) | Counts of connected people and devices by platform and app version - never an id ([census](#the-anonymous-census-and-its-24-hour-series-2026-11-02)) |
| GET | `/api/admin/presence/history` | yes (global admin) | The same counts, one sample a minute for the last 24 h |
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

If the JWT is invalid or absent, the upgrade is refused with HTTP `401`. Before that, the request's
`Origin` is checked ([below](#a-socket-upgrade-must-come-from-an-allowed-origin-2026-11-12)).

**Only an ACCESS token opens a socket** (`decode_access_claims` in `src/models.rs`). core-service
signs its access token and its refresh token with the same `JWT_SECRET` and HS256, and tells them
apart by the `type` claim: none (or `"access"`) on the access token, `"refresh"` on the refresh
token. The gateway reads that claim the way core-service does, so a refresh token is refused here
too, with a `warn` naming its kind. [call-service](call-service.md) carries the same check.

## Connection lifecycle

1. HTTP upgrade to WebSocket.
2. JWT validation -> extract `userId`.
3. Register in `connected_users["userId:deviceId"]` (mpsc sender).
4. Set Redis `user:online:{userId}:{deviceId}` (TTL 90s, `PRESENCE_TTL_SECS`, above the ~75 s dead-socket detection window).
5. Drain `pending_welcomes:{userId}` (Redis list of WS frames queued while offline).
6. Spawn `ws_read_loop` (client frames) and `ws_write_loop` (mpsc -> WS).
7. **End.** A client Close is answered, not dropped: the read loop does not break on
   `Message::Close`, so its next read sends the Close reply tungstenite queued and the stream ends -
   the handshake completes before the TCP close. A `{"type":"disconnect"}` frame ends the SESSION at
   once and the SOCKET on the client's Close (below).

### `disconnect` ends the session at once and the socket on the client's Close (2026-11-14)

On `disconnect` the gateway takes the connection out of `connected_users` (`remove_session`, so the
pub/sub loop hands nothing more to it), retires its session in Redis (`handle_disconnect`), and then
keeps READING: every client follows `disconnect` with its Close (web: `pausePlatformSocket` sends it
then `ws.close()`; the identity rotation closes the old socket as it reopens; Tauri: `ws.disconnect()`;
`beforeunload`: the page's own unload). Until the Close, a pong refreshes nothing and does NOT reset
the missed-ping counter, and any other frame ENDS the socket with a WARN: a frame after `disconnect`
means the client did not leave (a `beforeunload` the page cancelled - the carte editor's "leave this
page?" prompt answered "stay"), and a socket out of routing kept open would be deaf until the
client's own watchdog gave up (~32 s on the web); ended, the client's next heartbeat sees it closed
and reconnects (`a_frame_after_a_disconnect_ends_the_deaf_socket`). The termination is the Close,
that frame, or the socket ending; a client that sends none of them (an app suspended between its
`disconnect` and its Close, a half-open network) is ended by the existing heartbeat within
`DEAD_SOCKET_DETECTION_SECS` (75 s) of its `disconnect`, the same bound as any silent socket - no
timer of its own. A departed socket is out of `connected_users`, so it no longer counts toward the
admission limits while it waits; that window is bounded by the same 75 s.

**Why.** Until 2026-11-14 the loop broke on `disconnect`, dropping the TCP connection before
the client's Close was read. The frontend's nginx then closed the browser side with that frame
unread, which is a TCP reset, and the production edge logged `recv() failed (104: Connection reset by
peer) while proxying and reading from upstream` (three on 2026-11-13; the one still readable was an
identity-rotation socket of 0.3 s: open, `disconnect`, closed having sent 0 frames). It was not an
upstream keepalive race: the edge is layer 4 and the host's nginx pools no upstream connection.
`a_disconnect_leaves_routing_at_once_and_the_socket_ends_on_the_clients_close` (handlers.rs) holds
it: the client's first frame after `disconnect` is the Close reply; on the old loop the same test
reads a connection reset.

## Admission: one step, two limits (2026-11-12)

A socket's place is counted and registered in ONE step, `AppState::admit`, under the lock of the
connection map - so two requests arriving together are judged one after the other and neither limit
can be passed. Two limits, per process:

- **32 per account** (`MAX_CONNECTIONS_PER_ACCOUNT`), all its devices together. It is the ONLY
  bound on an account: a socket's `device_id` is chosen by its client, so a limit per device would
  bound nothing. Only the leader tab of a browser connects, so a device is one socket - plus those
  it has not released: on a flapping link a device can hold three or four that the heartbeat has
  not declared dead yet (about a minute each). The busiest account measured (2026-09-12) had 6
  live devices, so 6 x 4 = 24 fits; and 32 covers the 15 devices an account may enrol
  (chat-delivery's `MAX_DEVICES_PER_USER`; a gateway test reads both numbers) with one socket and
  its replacement each;
- **1000 in all** (`MAX_CONNECTIONS`).

**The place is taken BEFORE the upgrade, and a refusal is a `503`.** A client resets its
reconnection delay when its socket OPENS (`openGatewayConnection`), so a refusal delivered as a
close frame after the upgrade would be asked again at the shortest delay, forever. A request past a
limit is therefore never upgraded: the handshake fails, the client's socket never opens, and its
delay climbs. The account is counted first, so a refusal names the narrower reason.

The place is held by a `ConnectionGuard` that travels inside the upgrade callback (`Admitted`). A
socket that runs keeps it until its task ends; an upgrade that never completes drops the callback
unrun, and the place with it. A frame published between admission and upgrade waits in the
connection's channel. The duplicate-connection rule is unchanged - a new socket of a device is
added beside its siblings, never replaces them.

**What the count is made of.** `admit` counts the connection map, so the map must hold every live
socket and nothing else. A socket leaves it through its guard, by its own id. The pub/sub loop
also prunes (`prune_closed_senders`), and ONLY a sender whose socket is gone: a channel that is
merely FULL belongs to a live socket that is slow to read, which still holds its place - removing
it would let its account pass the limit while the socket lives.

The refusal is logged at WARN through `RepeatCounter`: the first one says the sentence, then the
10th, the 100th... carry the count (`[ws] socket REFUSED for <account> ... - refusal #N of this
episode`). The subject is the ACCOUNT when an account is at its limit, and `process` when the
process is full - one line for a full process, not one per account it turned away. A line at #100
is a client that keeps asking. **An episode ends on a fact, not a delay**: a subject admitted WITH
ROOM TO SPARE is forgotten, so its next refusal is said as #1 again. "With room to spare" because
a subject sitting at its limit is admitted each time one of its sockets leaves and refused again
at once - one episode, not many.

On the client a refused attempt is `[WS] Gateway connection failed` at ERROR, once per rung of the
reconnection ladder: a browser hides why a WebSocket failed, so the refusal cannot be named there,
and the line is true - a gateway that answered no.

**Owed reading: the 1000 against a measured peak.** The limit was chosen, not measured. What the
repository records today suggests roughly 250-350 live sockets at most, so 1000 leaves a wide
margin; the number that settles it is the census peak of
`GET /api/admin/presence/history?window=30d`, to be written here once read.

Frame size and per-socket message rate have no limit of the gateway's own yet; the ceiling is to be
measured before one is built.

## How a socket ENDED, and why the LEVEL of the line depends on it

The receive loop has three terminal arms and until 2026-09-15 one of them swallowed the other two:
`Err(e) => error!("WebSocket Error from {user_id}: {e}")`, whatever `e` was. **A browser that
reloads, navigates away or is killed sends no close frame** - the socket simply resets - so the
single commonest way a web session ends was recorded at the level reserved for things that are
wrong.

**MEASURED ON PRODUCTION, 2026-09-15, 7 days of `infrastructure-chat-gateway-1`:**

| | count |
| --- | --- |
| lines total | 2680 |
| at ERROR | 32 |
| of those, `Connection reset without closing handshake` | **32** (10 distinct users) |
| `Client closed connection` (the polite twin, at `info!`) | 3 |

So the gateway's ERROR channel carried exactly one thing, and that thing was people closing tabs. A
genuine fault would have arrived as one line among 33 and nobody would have gone looking. The rig
had already been forced to build a forgiveness list - `EXPECTED_ERRORS` in
`tools/cross-client-harness/srvlog.mjs` - whose ONLY member was this line, so that every reload the
campaign performs did not dirty its own window; that one-member list is most of the argument.

**The fix is a classification, not a demotion**, which is the distinction
[durable-rules](../durable-rules.md) draws when it forbids demoting a line. `axum` boxes the
`tungstenite::Error` exactly once (`Error::new(err)` in its `Stream` impl), so `source()` plus
`downcast_ref::<tungstenite::Error>()` hands back the real value and
`ProtocolError::ResetWithoutClosingHandshake` is a VARIANT rather than prose. `classify_socket_error`
in `handlers.rs` returns one of three outcomes:

- **`Goodbye`** - that variant and nothing else. Logged `info!("Client went away without a closing
  handshake")`, beside `Client closed connection` and at the SAME level: the two lines are one event
  differing only in whether the client was polite, and splitting them across levels would re-create
  the defect one rung down.
- **`Fault`** - deliberately *everything* else, including `ConnectionClosed` and `AlreadyClosed`,
  which read like goodbyes and are the tempting widening. They were not among the 32, and a
  predicate widened to cover what nobody has observed can never afterwards report it. If one starts
  appearing it will be the only ERROR line on the box, which is the point.
- **`Unreadable`** - the error under axum's is not a `tungstenite::Error` at all. This can only
  happen if a future `axum` bump stops unifying with this crate's direct `tokio-tungstenite`
  dependency (both resolve to `0.29` today, one entry each in `Cargo.lock`, asserted by a test), at which point every
  goodbye silently becomes a fault again. It is therefore **a signal, never a path**: logged at
  ERROR, naming that cause in the line itself.

All four cases are pinned in `handlers.rs`'s test module, the `Fault` ones as controls.

**WHAT READS DIFFERENTLY AFTERWARDS, named before the fix was written** (the rule
[testing-methodology](../testing-methodology.md) states after a no-op shipped with a CHANGELOG entry
promising a reduction that never happened): `WebSocket Error from ...` should fall from 32 per week
to 0 on production, with the same traffic reappearing as the new `info!` line.

### `Unreadable` fired in production, 2026-10-07 - the dependency had split

**MEASURED**: after `v1.1.2` the container log (started 2026-10-07 23:16, the whole window it
holds, ~1 h) held ONE `COULD NOT BE CLASSIFIED` line, from a `tauri-` device 1 s after connecting,
carrying `WebSocket protocol error: Connection reset without closing handshake` - an ordinary
goodbye, so the classifier was blind, not the client at fault. Cause: #944 bumped the direct
`tokio-tungstenite` to 0.30 while axum 0.8 resolves 0.29, so `Cargo.lock` held two and the
downcast never matched. The signal worked as designed; the guard against its cause did not exist.
**Fix at the source**: the direct dependency is back on 0.29, Dependabot ignores the crate (it
moves with axum, by hand), and `one_tokio_tungstenite_in_the_lock` fails the build on a split -
the existing unit tests could not, since they box this crate's own type. Expected afterwards: 0
`COULD NOT BE CLASSIFIED`, and the goodbye at `info!`.

### The after-count, 2026-09-22 - and the window the prediction could not have

**MEASURED ON `v0.18.18` (`d1cdae15a`), the whole log the production container holds:**

| | count |
| --- | --- |
| lines total | 626 |
| at ERROR | **0** |
| `Client went away without a closing handshake` (at `info!`) | 29 |
| at WARN | 5, all `No pong from ... after 4 pings` |

The prediction holds in both halves: the ERROR channel is empty, and the traffic it used to carry
reappears at `info!`, 29 times. **`EXPECTED_ERRORS` was deleted from
`tools/cross-client-harness/srvlog.mjs` the same day** - the whole bucket with it, not just its one
member - once all three estates the rig can target were confirmed to serve a build carrying the
classification (local image built 2026-09-21, dev on `86d345f7f`, prod on `d1cdae15a`). The old
ERROR spelling is now excused by nothing, which is what a run against an older build should meet.

**THE PREDICTION ASKED FOR A WINDOW THIS BOX CANNOT OFFER, AND THAT IS THE REUSABLE PART.** It was
written as `docker logs --since 168h`, against the 7-day baseline above. That command can never
return 7 days here: the gateway's log driver is `json-file`, whose file is **destroyed with the
container**, and every deploy recreates the container. Production deployed three times in the two
days before this measurement, so the longest window that has ever existed since the fix shipped is
**6 h 28 min** - which is what the table above reads, and it is why the after-count is stated as a
window rather than as a rate per week. The baseline was reachable only because it was taken during
an unusually long quiet period. Anything wanting a genuinely comparable 7-day count would have to
name a mechanism that outlives the container, and none is deployed.

## Per-frame lines: a typing frame is DEBUG (2026-11-13)

Production's gateway logged every typing frame three times at INFO (`Received WS JSON frame`,
`[WS RX]`, `[ROUTE]`), the last carrying the group's whole member list and costing a Redis
`SMEMBERS` per frame. A line is moved to DEBUG only when its own code says it is the ordinary path,
and a typing frame is: `EPHEMERAL_FRAMES` (`ws_dispatch.rs`, today `typing` alone) names the frames
sent many times a minute that mean nothing a minute later, and the three lines are DEBUG for those.
Every other frame keeps INFO, one line per message being the trace of a delivery. `[ROUTE]` no longer
lists members (nor asks Redis for them): who is online is what presence says.

## The heartbeat close is INFO (2026-11-13)

`[heartbeat] No pong ... closing dead connection` was a WARN, about as often as `Client went away
without a closing handshake` and for the same reason: a phone that lost its network or a laptop that
slept never answers, so the missed pongs ARE the ordinary end of most sessions. It sits beside that
line at the same level, as the two are one event (a session ended) differing in how it was noticed.

## What one connection sent, said once when it ends (2026-11-13)

Each connection carries a `FrameCensus` (`frame_census.rs`), fed by the receive loop, whose `Drop`
writes one line whichever way the connection ends - a close frame, a reset, or the sender half
ending first:

```
[WS FRAMES] <user>:<device> closed after 75s: frames=2 heartbeats=1 bytes=135 largest=120 peakPerMinute=2
```

`frames` is every inbound text frame, `heartbeats` the application pings among them, `largest` the
largest frame in bytes. It counts and refuses nothing.

**`peakPerMinute` is the busiest FIXED minute, counted from the open.** A burst that straddles two
windows is split between them, so the true count over any sixty seconds is at most twice the value
written. The clock only names the window.

**Why it exists.** A per-connection limit has to sit above what real clients send, and only the
gateway sees that: the delivery queue holds what is still stored, a sample of what was accepted.
A week of this line is the distribution the frame limits are sized from
([entry](../backlog.d/p2-gateway-frame-limits-sized-from-a-week-of-counts.md)).

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

### Inbound frames: `typing` is seat-checked, `welcome_request` is retired (2026-11-01)

`ws_dispatch.rs` acts on two inbound frame types, `disconnect` and `typing`.

- **`typing`** reaches every other online device in Redis `group:members:{groupId}`, and only when
  a device of the SENDER is in that set: a signal from an account with no seat there is dropped and
  logged `[TYPING] ... holds no seat ... REFUSED` at the 1st, 10th, 100th... occurrence per sender
  and group (`log_repeat.rs`, the gateway's copy of chat-delivery's `RepeatCounter`), since a client
  sends one per keystroke.
- **`welcome_request` is RETIRED** (`RETIRED_FRAMES`): it relayed a re-add request to one online
  member with no seat check. Every client asks over HTTP (`POST mls/welcome-request`, where
  chat-delivery checks the seat first -
  [chat-delivery](chat-delivery.md#the-relay-routes-ask-the-group-2026-11-01)); the frame is now
  ignored, answered with nothing, and logged `[WS] retired frame ... IGNORED` at the same powers of
  ten. A request stored by chat-delivery still reaches a member through the connection-time drain
  (step 5 of the lifecycle above).

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

## No Kafka consumer, and no broker - removed 2026-08-31

This gateway subscribed to a `post.created` topic under group `chat-gateway-broadcast` and
broadcast every record to **all** connected sockets as `{ type: "post_created", data: ... }`. It was
correct code with three separate reasons never to run:

1. **Nothing produced the topic, ever.** No `kafka` symbol exists anywhere in social-service.
   Measured on prod 2026-08-31: `kafka-topics --list` returned `__consumer_offsets` and nothing
   else, 42 hours into an uptime. The consumer logged `UnknownTopicOrPartition` at every boot.
2. **The two names never matched.** `libs/shared-rust` declared `TOPIC_POST_CREATED = "post_created"`
   while this file subscribed to the literal `"post.created"` - a producer written against the
   shared constant would have published past its only consumer, silently. That crate was itself
   deleted on 2026-08-31: with the broker gone it described a contract nothing in the system
   spoke, and this gateway named it as a path dependency without using a line of it.
3. **The client had no branch for the frame.** `post_created` was routed to `handleChannelEvent`,
   which implements no case for it, so a delivered record would have reached that handler's final
   `[ERROR] Unhandled channel event type` line on every connected client.

The consumer, `rdkafka`, and the `kafka` + `zookeeper` containers were removed together. They cost
1.09 GiB resident on production; this gateway does its whole job in 6.4 MiB.

**If real-time posts are wanted, they belong on the Redis path above**, which already carries eleven
event families and targets named recipients. The Kafka broadcast had no such filter: a post in a
private community would have gone to every socket on the server.

## Presence

Presence keys are stored in Redis as `user:online:{userId}:{deviceId}` with a 90-second TTL (`PRESENCE_TTL_SECS`, a compile-time-asserted margin over the 75 s ping/missed-pong detection window), refreshed on each WebSocket Pong. When delivery fails for a device and all senders are gone, the gateway proactively deletes the presence key so `chat-delivery-service` stops routing via pub/sub.

**Each session's declared capability is kept across processes (step A, 2026-10-22; `addressing.rs`).**
A socket opened with `caps=addressed-history-1` declares that its code refuses an addressed
conversation frame that is not a solicited, bounded history answer. Every presence write is one Lua
script, validated before its first write: the session's field in
`addressing:sessions:{userId}:{deviceId}` (`{process}:{connection}`, the capability or `-`, written
with its expiry by `HSETEX`), then the presence value `sessions-1` - unless an older gateway's `true`
is there, which is neither overwritten nor deleted, because it is the only trace of a session whose
declaration nobody can read. A session that ends is recorded in `addressing:left:{userId}:{deviceId}`
for one TTL before its field goes, so a refresh in flight cannot resurrect it, and the presence goes
in the same script only when the hash holds no field on any process - which is why neither the
explicit disconnect nor the "every sender dead" path decides it from this process's own map. Every reader that only tests existence is unchanged.
chat-delivery addresses a history answer only to a device whose value is `sessions-1` and every field
of whose hash is the capability ([history-answer-addressing](../protocols/history-answer-addressing.md),
rule 6). The pub/sub loop forwards the row's `addressed` flag, and hands an addressed frame only to the
local sessions that declared - every one withheld is logged at error.

**A second capability gets its own hash, never a new spelling of the first (2026-10-25,
`SessionCaps`).** `caps=` is comma-separated; `addressed-history-1` and `join-ask-1` (a build that
routes the invitation-link ask frames) are each recorded in THEIR OWN hash, under the same session
field and in the same script: `addressing:sessions:*` keeps exactly `addressed-history-1` or `-`, and
`addressing:join-ask:*` holds `join-ask-1` or `-`. `WRITE_SESSION` refuses any other value, and
`LEAVE_SESSION` removes the field from both. chat-delivery's join-ask script requires every field of
the sessions hash to have its twin valued `join-ask-1`, so a session an older gateway recorded (no
twin) counts as not declaring it. A control frame naming `requiresCapability` is delivered only to the
local sessions holding it (`required_capability`, `deliverable_sessions`); an unknown name drops the
frame at error.

*Why apart - the first build of #2442 wrote the list `addressed-history-1,join-ask-1` into the one
field, and every SHIPPED chat-delivery compares that value WHOLE.* Kept apart, no reader ever meets a
value it does not know, so the deploy is safe BY CONSTRUCTION rather than by the order containers are
replaced:

- **Forward, either order.** An old chat-delivery beside this gateway reads the history hash it always
  read, byte-identical (`addressing.redis.spec.ts` runs the shipped script on the new shape); an old
  gateway beside the new chat-delivery writes no twin, so its devices simply get no ask frame.
- **Rollback.** An older gateway records history as before and no twin; the twins this one wrote
  expire with their TTL and are read only through a sessions-hash field, so a stale twin opens nothing.
- **Mixed sessions** (one tab on an older build): history is decided exactly as before, and no ask
  frame is published to the device while one session lacks `join-ask-1`.

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
  peers see the user offline without waiting out the TTL. Since 2026-11-14 the sending connection
  leaves `connected_users` first (`remove_session`), and the shared sessions hash decides the
  presence key ([above](#disconnect-ends-the-session-at-once-and-the-socket-on-the-clients-close-2026-11-14)).

Until 2026-08-16 the second path deleted unconditionally, so a tab navigating away marked the whole
device offline; `drop` then ran, saw the survivor, and took the skip branch, so the guard written to
protect the key was exactly what stopped it being restored. Peers read the user offline until the
surviving socket's next `refresh_presence`. The decision is covered by five unit tests in
`state.rs` that need neither Redis nor a socket.

### Who may see whose presence (WP-PRESENCE, 2026-10-18)

Decided by the user: **"is X online" is visible to X, and to anyone who shares a live conversation
or a community with X** - nobody else. Until then any signed-in caller could ask about any user id
(and before 2026-09-10 any caller at all).

The gateway owns no table that says who shares what, so a presence read (`POST /api/presence`, and its legacy GET) asks the two services
that do, concurrently, each about its own tables, and takes the union (`audience.rs`):

| Asked of | Route (`X-Internal-Secret`) | Table |
|---|---|---|
| chat-delivery | `POST /api/internal/presence/shared-conversations` | `dm_group_members`, tombstoned conversations excluded |
| social-service | `POST /api/internal/presence/shared-communities` | `channel_members` on a common `workspaceId` |

Both take `{ viewerId, userIds }` and answer `{ userIds }`, the visible subset, lowercased (the
spelling every Nest guard stores ids under). The caller always sees themself without asking. A
key-distribution group has no `dm_group_members` row, so it cannot widen the audience.

**The answers, and why each one:**

- An asked user the caller may not see is **absent from the map** - not `false`, and never a
  401/403, which a client may read as "sign out". An old client (floors 1.2.7 / 1.0.3) merges the
  map into its own, so the key never turning up just leaves its dot off: it degrades quietly. A new
  client (`presenceStore.ts`) reads absence as "not visible" and drops the id, so someone who
  stopped sharing anything does not keep a dot frozen at its last value.
- **503** when either service cannot answer, when `INTERNAL_SECRET` / a service URL is unset (also
  logged at boot), or when Redis cannot be read. Half an audience would hide exactly the people the
  missing half would show, and an empty map would read as "nobody is visible". A service refusing the
  GATEWAY (403) reaches the client as this 503, never as a refusal of the client.
- **400** above `MAX_PRESENCE_USERS` (1000) distinct ids; the client splits a longer watchlist into requests of at most that many (`presenceStore.ts`), so an honest client never meets it. A POST body that is not `{ users: string[] }` with a JSON `Content-Type` is also a 400, after the 401 for an anonymous caller.
- The SCAN of `user:online:{id}:*` runs only for the visible ids, so a crafted id never reaches a
  SCAN pattern unless a service has matched it to a real membership.

**The costs taken knowingly, each written down so nobody files it as a defect:**

- **"Not visible" and "offline" are two answers, and the map tells them apart by ABSENCE** - a
  deviation from the old contract, where every asked id came back with a boolean. A visible user
  who is offline is `false`; a user the caller may not see is missing. Answering `false` for both
  would state "offline" about someone who may be online, and would make "hidden" and "offline" one
  value no client could ever separate again; the price is that a client must read a missing key as
  a fact (`presenceStore.ts` does) rather than as "not answered yet".
- **A block does not hide presence.** The audience reads membership tables only, and a block ends
  no membership ([moderation-and-blocking](../moderation-and-blocking.md#what-a-block-does-not-do)).
- **An OLD client keeps a frozen dot for someone who left the only conversation it shared.** It
  merges the map, so a key that stops coming keeps its last value - `true` included - until the
  app restarts or the store is rebuilt. Only `presenceStore.ts`'s drop of an absent id fixes it,
  and that rides the next client release; nothing server-side can reach a client that merges.
- **A rolling deploy has a 503 window.** A gateway that comes up before chat-delivery or
  social-service serve `/internal/presence/*` gets 404s, answers 503, and logs
  `[presence] audience unavailable ... answering 503` at WARN once per poll per open client (every
  10 s) until both services are up. The client keeps its previous map through a 503, so nothing on
  screen moves; the lines are the expected trace of the window, and lines that OUTLIVE a deploy
  are a broken audience, not noise.
- **The 1000-id cap is one number in three places** (`MAX_PRESENCE_USERS` here, and the validator
  the two services share byte for byte, `src/utils/presence-audience.ts`, declared in
  `declared-duplicates.mjs`). `libs/contracts/presence-audience.cases.json` is the one copy the
  three assert against ([libs](../libs.md#presence-audiencecasesjson)).
- **Both viewer lookups have an index of their own**: `IDX_dm_group_members_user` (chat-delivery
  migration 031) and `IDX_channel_members_user` (social-service migration 089). The only indexes
  before were the unique (`groupId`, `userId`) and (`workspaceId`, `userId`), which cannot serve a
  predicate on `userId` alone, so every poll scanned both membership tables. **No time-based cache
  in front of them**: a 10 s poll behind a 5-10 s cache is a clock deciding what a member sees
  after leaving, and the index is what makes the question cheap.

Covered by `presence.rs` (the real handler against fake services on loopback, Redis deliberately
down so the STATUS says how far a request got), `audience.rs`, one spec per service, the shared
contract above, and `internal-presence.integration.spec.ts` (social-service, the community query
and migration 089 against a real PostgreSQL).

### The ids travel in a body, never in the URL (2026-10-28)

Until then the read was `GET /api/presence?users=<id>,<id>,...`, every watched id (64 hex
characters each) in the request line, every 10 s. A request line is written to every proxy's access
log, so: a reverse-proxy log scanner flagged the very long query strings as a possible attack, over
and over; the ids of everybody a member watches sat in logs of a host this project does not own; and
a long enough watchlist outgrows a proxy's header buffer (nginx's 8 kB default, the edge's limit),
failing that member's presence with nothing server-side to show for it.

**One route, one body, one split.** `POST /api/presence` takes `{ "users": [...] }` and answers
exactly what the GET answered (`answer_presence` in `presence.rs` is the one answer behind both): the
same audience, the same 1000-id cap, the same 401/400/503. `presenceStore.ts` cuts the watchlist into
requests of at most `PRESENCE_IDS_PER_REQUEST` (= the contract's `maxUserIds`, pinned by
`presenceStore.contract.test.ts`) in ONE function, `presenceChunks`, in watchlist order; the requests
of one poll go one after the other, and any of them giving no usable answer leaves the whole map as it
was. Nothing is timed. nginx serves the POST through the same `location /api/presence` and the same
`auth_request` (its sub-request carries no body), with ONE addition: `client_max_body_size 128k`
there (1000 ids are ~70 kB), because the server-wide 100m upload limit is no bound and the gateway
READS a body before it can refuse an anonymous caller - the JSON extractor runs before the handler,
so the 401 is decided first but not before the read. The CORS layer already allowed POST and mirrors
the preflight's headers; `apiFetch` logs it at debug like the GET (`POLL_ROUTES` matches the path,
whatever the method). A refused body is logged by its KIND only (`rejection_kind`): serde's message
quotes the value it choked on, and a presence body is a list of ids.

**The client sends the POST only to an estate that says it serves it**: `presencePost: true` in
`GET /api/version`, read through `serverPresencePost()` - the live answer, or the session's CACHED
answer when no live one is held (a failed probe, offline, the window before the first refresh), so a
healthy cache never leaves presence dark until the next focus. A stable ships both stores BEFORE production
deploys, so for days a new phone build talks to the old gateway, which would answer the POST `405`;
there the client keeps the legacy GET, one request as before. Before `/api/version` has answered at
all, the client asks nothing (one debug line) rather than guessing a route. **core-service publishes
a fact about the gateway** - deliberately: both are built from one release tag and deployed together,
and `/api/version` is the one capability document every client already reads. The cost: during a
rolling deploy a client that read the new `/api/version` before the new gateway is up gets a few
`Presence request failed with status 405` warnings and keeps its map; lines that outlive a deploy are a
broken deploy.

**What the POST costs, taken knowingly:** it is not retried on a stalled head (`apiFetch` replays a
GET once, never a write) and it has the write deadline (30 s, not 20 s); the next 10 s tick is the
retry. A preflighted client pays one more preflight per 2 h for the new method.

**The legacy GET stays for installed clients** and is counted: `LegacyGetTally` writes ONE line per
window of at least an hour, closed by the first legacy call after it (no timer task) -
`[presence] legacy GET /api/presence served N calls from M callers in the last Ss`. Silence is the
zero its removal waits for ([legacy-compatibility](../legacy-compatibility.md#no-date-yet---the-presence-ids-in-a-url)).
nginx's access log drops that route's query (`/api/presence?query-redacted`, `access-log-redaction.test.mjs`),
so even those clients' ids are no longer written there.

**The push is NOT done, and the 10 s poll stands.** A push needs a presence TRANSITION event, and the
gateway emits none: the key is set in one place (connect), refreshed in another, deleted in three
(`ConnectionGuard::drop`, `handle_disconnect`, the delivery-failure DEL in `subscribers.rs`), and
expires by TTL with no event at all. Replacing the poll means (1) one publish on every online/offline
EDGE of a USER (a device leaving while another stays is no edge, which needs a SCAN after each DEL),
(2) a per-connection watch set checked against this same audience, (3) a client that keeps polling
until the gateway proves it pushes (a phone build can reach the stores before production carries the
gateway that answers it). **None of the three is built**, and the backlog entry that owns the poll
says so ([backlog](../backlog.d/p3-the-phone-polls-presence-every-ten-seconds-over-a-live-websocket-2026-09-02.md)).

## The anonymous census and its 24-hour series (2026-11-02)

**The owner's request (2026-11-02):** `/admin/status` listed every connected person and device; it
now counts them - *"un outil de monitoring, avec une courbe des dernieres 24h (anonyme), avec la
plateforme, la version"*. The page is `frontend/src/routes/admin/status/+page.svelte`
(totals, two line charts, the versions live now); the server side is `census.rs` and the two admin routes in
`presence.rs`.

**Aggregate, every cell kept.** `GET /api/admin/presence` answers `{ devices, users, groups: [{ platform,
version, devices, users }] }`; `GET /api/admin/presence/history?window=24h|7d|30d` answers `{ now,
intervalSecs, windowSecs, samples: [{ t, devices, users, groups }] }`. No user id, device id, address or per-person
field exists on either wire - `the_admin_routes_return_counts_and_never_an_id` seeds a device with
known ids against a real Redis and fails if any body (all three windows) contains one, and the page's test fails if a
stray `userId` in a response reaches the DOM. `users` is DISTINCT over the whole population (one
person on a phone and a laptop is one user, two devices), so it is not the sum of the groups.

**Small cells are NOT merged any more (owner's decision, 2026-11-05).** Until then (review of #2956) a
(platform, version) cell of fewer than 3 devices or people was merged into `other` before a sample was
kept, because a cell holding ONE person lets an admin read that person's connections to the minute. The
owner reversed it: *"Je veux chaque version, chaque plateforme, avec de jolies courbes."* Every
(platform, version) cell now has its own line, even for one person, and `HISTORY_MIN_CELL` and the
two-pass merge in `aggregate` are gone. **Why that was his to decide, and why it is reversible:** the
rule was a privacy-by-design choice made by us for a tool only global admins can open, not a legal or
security requirement; and it can come back for what is written from then on, because the merge happened at WRITE
time. **What it does NOT undo, stated plainly:** samples written BEFORE 2026-11-05 still carry the merged `other`
cells (so the 24 h and 7 d curves show those older stretches coarser, and that is honest), and
samples written AFTER it hold every cell: if the rule were restored, up to 30 days of fine cells would stay readable in Redis (24 h
in the fine series, 30 d in the 5-minute one) until they expire by themselves. To drop them at once,
purge both keys by hand with `DEL monitor:presence:samples monitor:presence:samples:5m` (disposable by
nature: it loses the charts' history, never a fact the product needs; the sampler starts them again on the next minute). **What an admin can now read, stated exactly:** for each of the 24 h /
7 d / 30 d windows, how many devices ran each (platform, version) at each point, down to a cell of 1, so
a version or platform with a single device draws a line that rises and falls with that one device's
connections (to the minute over 24 h, to 5 or 30 minutes beyond). Still no identifier of any kind on the
wire; a cell does not say WHO, only that the cell was non-empty - but in a small association an admin who
knows who runs a given pre-release can infer it. That inference is accepted with the decision.
**What still bounds the series** (abuse, never privacy): the platform allowlist (six names, else
`other`), the version grammar and length, at most 32 versions per sample (the rarest merging into
`other`), and a cap of 64 cells on every stored point (a minute or a coarse bucket; the smallest beyond it are summed into `(other, other)`).

**What a socket declares.** The client adds `platform=` (`web`, or the native shell's own name:
`android`, `ios`, `macos`, `windows`, `linux`) and `app_version=` (`VITE_APP_VERSION`, the very
string `minClientVersion` is compared against) to the `/api/ws` URL, built in the one function both
openers share (`gatewaySocketUrl`). The gateway BOUNDS what it reads (`ClientKind::from_query`): a
platform outside the six is `other`, a version that is not `[0-9A-Za-z.-]{1,32}` is `other` (build
metadata after `+` is dropped), nothing declared is `unknown` (every build before this one), and a
sample names at most 32 versions, the rarest merging into `other` - so a hostile client cannot mint
a series or grow a sample. **`unknown` means an old client, or one that has not declared yet - including devices that a replica older than this feature held during a rolling deploy** (it writes no declaration key). nginx's access log already redacts the `/api/ws` query's token, and these
two values name no one.

**Where it is kept, and why Redis.** The declaration is a string `monitor:client:{userId}:{deviceId}`
(`platform|version`), written beside every presence refresh with the SAME 90 s TTL, outside the
`user:*` namespace the presence scans match, and DELETED by the same script that deletes the presence
key (`LEAVE_SESSION`: a clean disconnect, the connection guard, the every-sender-dead path) - never
while another session still holds the device; after an unclean end it expires with the presence key
it sits beside. The series is ONE sorted set,
`monitor:presence:samples`, scored by the minute a sample describes, one JSON member per minute.
**Redis, not Postgres,** because every input is already Redis state with a 90 s life, the gateway has
no database (adding one for 1440 rows a day would add a dependency, a migration and a backup scope to
a service whose point is to need none), the data is disposable by nature (losing it loses a chart,
never a fact the product needs) and a sorted set trims itself by score. Nothing is added to
`infrastructure/MIGRATION.md`: no table, no secret, no service, no new env var.

**Two gateways during a rolling deploy must not double count, so no replica counts for itself.**
The census is derived from the SHARED `user:online:*` keys (one key per DEVICE, whatever process
holds its sessions) joined with the declaration keys - never from a process's own socket map, which
would count a device with a session on each replica twice. The series write is IDEMPOTENT PER
MINUTE: every replica samples at every minute boundary and one script (`RECORD_SAMPLE`) writes the
minute only if the sorted set has no member at that score, so the first replica wins and the others
find it taken. There is no leader, no lock and no election; the number of replicas changes nothing
(`two_replicas_sampling_the_same_minute_write_it_once`, `a_device_counts_once_whatever_gateway_holds_it`).
A taken minute costs ONE `ZCOUNT`: every replica asks that first and skips the scan of the
presence keys when another already wrote it.

**Time comes from Redis, never from a replica (review of #2956).** The script reads `TIME`, trims
against it, and REFUSES a minute more than one interval away from it - nothing is written or trimmed,
and the replica logs at warn how many seconds ahead of or behind Redis it is. Without that, a
replica two hours ahead would trim real history relative to a future minute, plant samples the read
would serve, and hold minute slots the correct replicas then find taken. The read is bounded to
Redis's now as well (`(now-86400, now]`), so even a foreign future-scored member is never served. A
replica's own clock only decides WHEN it tries (`a_write_skewed_ahead_neither_trims_nor_appears`);
an unreadable or skewed minute is a gap, never a wrong count.

**Retention and gaps.** The same script trims `-inf .. now - 86400` (Redis's now) after every write, and gives the
key an expiry of 25 h as a backstop - 1440 members at steady state, deleted by the write that makes
them old, not by a timer. A minute nobody sampled (every gateway restarting, Redis unreachable) has
NO member; the history answers only what exists, `buildBuckets` lays the window out point by point
and leaves the missing ones `null`, and every line breaks there. **Nothing is interpolated.** A Redis that cannot be read answers 503, never an empty
census: zero would be a claim.

**The 7-day and 30-day windows (2026-11-05): a second series, `monitor:presence:samples:5m`.** One
member per 5 minutes (scored by the bucket's start), kept 30 days, in the same Redis. Written by the
replica that WROTE the minute in the fine series (`record_coarse`, right after `record_sample`
answers `Wrote`): it reads the bucket, folds the minute in with `merge_max`, and writes it back through
a compare-and-swap script (`RECORD_COARSE`, up to 5 attempts; a lost race is logged at warn and costs
that bucket one minute, never a wrong count). **The aggregate is the MAX per bucket, not the mean**,
because (1) a max is idempotent and order-free - applying a minute twice, or two minutes in any
order, lands on the same bucket, which a mean cannot do without also storing a count and a sum; (2) it
answers the capacity question the page serves ("how many were connected AT MOST?"), where a mean
smooths away exactly the peaks that decide a minimum-version cutoff; (3) a one-minute connection of a
lone device still shows on the 7 d / 30 d curve instead of being diluted to a fifth. The price: every cell's
maximum is taken independently, so the cells of a bucket need not add up to the bucket's total maximum
(they peak at different minutes), and the curves overstate steady load slightly. The 30-day window is
served from the same series rolled up to 30 minutes (`rollup_max`, the same max), so no window answers
more than 2016 points: 24 h = 1440 (60 s), 7 d = 2016 (300 s), 30 d = 1440 (1800 s); `intervalSecs` and
`windowSecs` in the answer say which. A period with no bucket is a gap, exactly as in the fine series.
The route takes `window` from a closed set (`24h`, `7d`, `30d`; absent = `24h`); any other value is a 400, so no request
can ask for an unbounded read. The coarse series does not backfill: it starts at the first deploy that
carries it, and the 7 d / 30 d charts are blank (a gap) before that.

**Version colours are stable (2026-11-05).** A version's line takes the categorical slot of its place counted
from the OLDEST version still shown (`buildSeries`), not from the newest: a release newer than every one on screen takes
the next free slot and no older line is repainted (`does not repaint an older version when a newer one ships`). The cost: the
oldest version leaving the window shifts the others by one, and past eight versions the newest laps round with a dash
pattern. A hash of the version string was rejected: with 5 versions in 8 slots a collision is likely, and a collision
between two live versions is worse than a shift when an old one expires. The colours are `--chart-series-*` in `app.css`, each slot at
least 3:1 against its surface (the computed table is in the comment there).

**The size of the coarse series, in numbers.** 30 d x 288 buckets/day = **8,640 members**. A member is
`{"t":..,"devices":..,"users":..,"groups":[{"platform":"android","version":"1.6.5-alpha.2","devices":3,"users":3}, ...]}`:
about 75 bytes per group plus ~50 of envelope. **Typical** (about 15 cells: 6 platforms x a few live
versions): 15 x 75 + 50 = ~1.2 KB, so 8,640 x 1.2 KB = **~10 MB**. **Hard ceiling:** a stored point keeps at most
64 cells (`MAX_GROUPS_PER_POINT`; the smallest beyond it are summed into `(other, other)`), so 64 x 75 + 50 = ~4.9 KB and
8,640 x 4.9 KB = **~42 MB**, whatever clients declare (without the cap, 33 versions x 8 platforms = 264 cells
could reach ~170 MB). The fine series obeys the same cap: 1,440 x 1.2 KB = ~1.7 MB typical, 1,440 x 4.9 KB = ~7 MB at the ceiling. The whole census is
**~12 MB typical, ~49 MB at the ceiling**. The key expires 30 d + 1 h after its last write and the same
script trims everything older than 30 d, so it never grows past that. Reading a window costs one
`ZRANGEBYSCORE` of at most 8,640 members (7 d: 2,016; 30 d: 8,640 then rolled up in memory) and happens
only for an admin looking at the page.

**The page polls only while it is looked at.** The 10 s (live) and 60 s (history) polls stop when
the tab is hidden and one read happens the moment it is shown again; each request scans the presence
keys, so a forgotten tab must not keep asking. The page keeps one failure flag per source, so a live
read that succeeds never clears a history read that failed.

**Register.** The series is counts by platform and version, every cell kept (owner's decision of
2026-11-05, above) over 24 h at one sample a minute, and 30 days at one bucket per 5 minutes; row C18
says exactly that. The only thing tied to an account is the
declaration key, for at most 90 s after the device's last pong and gone with the presence key on a
clean end - the lifetime and purpose of the presence key it sits beside. The ADMIN's view shrank: it
no longer shows a list of connected people. The privacy policy needs no change.

## A socket upgrade must come from an allowed origin (2026-11-12)

The rule, in `src/origin.rs`, applied by `admit_origin` (`handlers.rs`) before the token is read:

- an `Origin` header that is **present** must be one of the entries of `ALLOW_ORIGIN`, compared
  exactly as the CORS layer compares them, or the upgrade is answered `403` and no socket opens;
- an **absent** `Origin` is accepted. A native client opens its socket outside any page: the Tauri
  socket plugin builds its request from the URL alone and sends none;
- **`*` is never a list.** With `ALLOW_ORIGIN=*` there is nothing to match a page against, so every
  upgrade that names an origin is refused, and the gateway says so at ERROR when it starts. It does
  not fall back to accepting everything.

So the list below must hold every origin a shipped client's PAGE has: an entry removed costs that
client its socket. The call signalling socket is opened by the WebView itself, so on a phone its
origin is the Tauri one.

**The refusal is logged with the origin it refused**, once per distinct value and then at each power
of ten (`[ws] upgrade REFUSED: origin "..." is not in ALLOW_ORIGIN`). That line is the reading to
take after a deploy: a client turned away appears there by name, and nowhere else.

The local estate lists the nginx entry, the Vite dev server and the Tauri WebViews
(`infrastructure/local/docker-compose.yml`); a page served from another address is added through
`CANARI_LOCAL_ALLOW_ORIGIN`.

Tests: `origin.rs` for the rule, and in `handlers.rs` a real handshake against the served router for
each side (listed, absent, not listed, `null`, and a wildcard).

## CORS: the list is a fact about the clients

`ALLOW_ORIGIN` is a comma-separated allowlist, `*` allows all, and `chat_gateway_cors_layer`
(`main.rs`) turns it into the `CorsLayer` wrapping every route. nginx does not speak CORS for any
of them - it proxies `/api/ws`, `/api/presence` and `/api/admin/presence` straight through - so
this layer is the only one answering, which is why the value has to be right here and nowhere else.

**It served `*` in production until 2026-08-30, and the allowlist CD wrote had never reached the
container.** `docker-compose.prod.yml` set `ALLOW_ORIGIN: "*"` as a **literal** on the service, and
a literal there wins over anything in `infrastructure/.env`, so `upsert_env_var "ALLOW_ORIGIN" ...`
in `deploy.yml` had been writing a value nothing read since the iOS login incident. Measured twice:

```
docker exec infrastructure-chat-gateway-1 printenv ALLOW_ORIGIN   -> *
OPTIONS https://canari-emse.fr/api/presence  Origin: https://evil.example
  -> 200, access-control-allow-origin: *
```

That stayed a P2 rather than a P1 because this layer sets no `Allow-Credentials`: nothing
credentialed could be read back cross-origin. It is also why the gateway was never implicated in
the iOS login failure - it accepted the very origin the four Nest services refused.

**The service now reads `${ALLOW_ORIGIN:?...}`, which stops the deploy when the variable is absent
rather than picking a default.** Both available defaults are wrong: a wildcard silently re-opens
this, and a single origin silently cuts every Tauri client off `/api/presence`. An absent
declaration is a mistake, and a mistake that picks a policy is worse than one that stops.

### Every entry, and why it is there

Enumerated in `infrastructure/.env.example`, written by `serve-prod.yml`, and pinned by the tests in
`main.rs` that drive a real preflight through the layer:

| Origin | Client |
|---|---|
| `https://canari-emse.fr` | the deployed site (`FRONTEND_URL`) |
| `https://dev.canari-emse.fr` | a proxied CNAME onto this **same** tunnel, not a second environment - a list built from `FRONTEND_URL` alone would refuse a hostname this stack serves |
| `http://tauri.localhost`, `https://tauri.localhost` | the Tauri WebView on Android and Windows |
| `tauri://localhost` | the Tauri WebView on iOS, macOS and Linux - WebKit keeps the custom scheme |

The Tauri app calls this gateway **cross-origin** (its page is served from `tauri://localhost`, the
API from `https://canari-emse.fr`), so dropping a spelling costs that platform `/api/presence` with
no server-side error to show for it. Keep it in step with `TAURI_WEBVIEW_ORIGINS` in
`apps/*/src/cors-origins.ts`.

**The CORS allowlist is exact, here and in the four Nest services; no loopback origin in
production.** The Vite dev server (`http://localhost:1420`, and `http://127.0.0.1:1420` as
`tauri.conf.json`'s `devUrl` spells it) is a client of the dev and local estates only, so only
their lists name it: `compute_allow_origin` in `infrastructure/deploy/render-env.sh` writes the
pair for dev and not for production, and the local compose file spells it out. The Nest services
accept an origin on one ground, that a list names it: `FRONTEND_URL`, the three WebView
spellings, and this same `ALLOW_ORIGIN` on the estates whose compose file hands it to them (dev
and local; production's does not). Pinned by `deploy-env.test.sh` (both rendered lists), the
preflight tests in `main.rs` and `cors-origins.spec.ts`.

### Verifying it, and why the deploy's colour is not the proof

A `HeaderValue` accepts almost any printable ASCII, so a **wrong** origin parses happily and simply
matches nothing - only an empty list stops the boot, which the tests pin. What proves the policy is
reading the header back off the deployed gateway:

```
OPTIONS https://canari-emse.fr/api/presence  Origin: <each entry>  -> echoes that origin
OPTIONS https://canari-emse.fr/api/presence  Origin: https://evil.example  -> no ACAO header
```

The layer also sends `Vary: origin`, which a shared cache needs before it can hold more than one
client's answer; a test asserts it for the same reason.

**Measured on prod 2026-08-30**, after the deploy that carried the fix, at BOTH layers - inside the
network against `http://chat-gateway:3000` and through the public edge - because only the second is
what a browser meets and only the first isolates this layer from nginx:

```
ALLOW_ORIGIN in the container   -> all seven entries present  (docker inspect)
each of the seven origins       -> echoed back verbatim, no '*' anywhere
https://evil.example.com        -> HTTP 200, no ACAO header
                                -> vary: origin
```

A preflight carries no cookies, so `auth_request` cannot see a session on it - the edge answers the
`OPTIONS` 200 either way, which is why the unknown origin's proof is the ABSENCE of the header and
never a status code. Run it from `infrastructure-frontend-1`, the one container on that network with
`curl`.

### The variable used to feed three consumers that wanted a single origin

`frontend-ssr`'s `ORIGIN` - adapter-node's public origin - read `${ALLOW_ORIGIN:-...}` and was
measured on prod holding the whole comma-separated list as one origin. It read `FRONTEND_URL` after that, and since adapter-node 6 (2026-10-27) there is no `ORIGIN` at all: the origin is derived per request ([architecture](../frontend/architecture.md)).
The nginx `frontend` service's `ORIGIN`, `VITE_GATEWAY_URL` and `VITE_DELIVERY_URL` read it too and
are **deleted**: that image is `nginx:stable-alpine` serving a build with no entrypoint
substituting anything, and a `VITE_` variable is baked in at BUILD time by the workflows writing
`frontend/.env`. **A variable read by two consumers with different shapes is one of them being
wrong**, and nothing said so for either.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `REDIS_URL` | no | `redis://127.0.0.1/` | Redis connection string |
| `JWT_SECRET` | yes | - | HS256 JWT secret (shared with core-service) |
| `DELIVERY_SERVICE_URL` | yes | - | chat-delivery base, no `/api` (`http://chat-delivery-service:3010`); asked for the conversation half of the presence audience. Unset: every presence read is a 503, logged at boot |
| `SOCIAL_SERVICE_URL` | yes | - | social-service base, no `/api` (`http://social-service:3014`); asked for the community half. Unset: same |
| `INTERNAL_SECRET` | yes | - | Sent as `X-Internal-Secret` on both audience questions. Unset: same |
| `ALLOW_ORIGIN` | **yes under compose** | `*` (binary only) | CORS allowlist, and the origins a socket upgrade may name (`*` admits none of those). `docker-compose.prod.yml` uses `${ALLOW_ORIGIN:?}` and the deploy stops without it; the binary's own `*` default is for running it by hand and logs a WARN accusing the missing declaration |
| `RUST_LOG` | no | `chat_gateway=debug,tower_http=debug` | Log filter |
