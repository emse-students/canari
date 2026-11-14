## P3 - the edge logs a reset when the chat-gateway ends a socket on `disconnect` before the client's Close is read

target: 1.8.0

**What was seen (production edge, 2026-11-13, read 2026-11-14).** Three `recv() failed (104:
Connection reset by peer) while proxying and reading from upstream` lines at 19:47:34, 20:31:43 and
22:45:01 UTC, hours from any deploy or reload; client the host's nginx (through Docker's port proxy),
upstream a `frontend` replica; bytes from/to upstream 773/813, 756/790 and 809/1485 - one exchange
each, then the reset. 0 such lines on dev in 72 hours.

**The keepalive race is refuted, by configuration.** It needs a proxy that keeps an IDLE upstream
connection and reuses it after the server closed it. Neither proxy in front of the frontend has one:

- the edge is layer 4 (`stream`, [nginx.conf](../../../infrastructure/edge/nginx.conf)): one client
  connection is one upstream connection, nothing is pooled;
- the host's nginx (the school's, read-only 2026-11-14) proxies to the edge with
  `proxy_http_version 1.1` and `Connection $http_connection` but NO `upstream { keepalive }` block,
  so it closes its upstream connection after every response and never reuses one.

The frontend's own values, for the record: `keepalive_timeout 65` (the base image's, the conf sets
none), `keepalive_requests` the default 1000, no `reset_timedout_connection`, no `lingering_*`, no
`return 444`. Nothing to shorten: no client of it holds an idle connection.

**What a `104` here means.** Linux answers with `ECONNRESET` (not `EPIPE`) only when the RST reaches a
socket still ESTABLISHED, so the frontend's nginx sent a reset without a FIN first: it closed a socket
that still held bytes it had not read. A client abort would have read `499` at the frontend and
nothing at error level on the edge.

**The one that can be read is a WebSocket the gateway ended under the client's Close.** The live
frontend log had rotated past all three; the deploy archive of `v1.6.12` (frontend-19, read-only)
starts at 21:29, so only 22:45:01 is covered. At that second it holds exactly one candidate:
`GET /api/ws ... 101 0 ... rt=0.300 urt=0.296 ust=101` - a socket of 0.3 s that sent the client
nothing. The chat-gateway's archive tells its story: the socket opened at 22:45:01.695, received
`type=disconnect` at 22:45:01.984 (`[presence] Explicit disconnect`), and closed at 22:45:01.989
having sent 0 frames; the client then retired that device id and opened under a new one (the
identity-rotation path, `BaseMlsService` `sendDisconnect()` then a reopen). Every client sends
`disconnect` and closes its socket right after (`WebMlsService.pausePlatformSocket`:
`sendDisconnect()` then `ws.close()`; the Tauri pause calls `ws.disconnect()`). The gateway answers
`disconnect` by BREAKING its receive loop
([handlers.rs](../../../apps/chat-gateway/src/handlers.rs), the `"disconnect"` arm), so it ends the
TCP connection without waiting for that Close. The frontend's nginx sees its upstream end and closes
the client side while the browser's Close frame sits unread in it - the reset. The edge's 1485 bytes
from the client fit a handshake plus the `disconnect` and Close frames.

**Not explained: the other two.** 773 and 756 bytes from the upstream differ from the 809 of the
`101` above, so they may be `101`s with a different `Access-Control-Allow-Origin` echo (an app's
origin) or another request; nothing kept says which.

**The fix, designed and not built.** The gateway must END a socket on `disconnect` the way RFC 6455
ends one: retire the session at once (as now), take the connection out of local routing at once
(so no frame is handed to a socket the client is closing), then READ until the client's Close - the
proof the client has sent its last byte - and only then drop it. Not a timer: the Close every client
already sends is the termination. The Tauri pause comment that relies on the gateway closing first
(`TauriMlsService`, the `disconnect()` refusal it treats as the answer) is revisited in the same
change, and the gateway's frame census and `Client closed connection` line keep counting it as one
event ([chat-gateway](../services/chat-gateway.md#how-a-socket-ended-and-why-the-level-of-the-line-depends-on-it)).

**Done when** the gateway waits for the Close after `disconnect`, and a week of the production edge's
log holds 0 `104 ... reading from upstream` (or each one left is read, within the frontend log's
~12-hour window, to a request other than a `disconnect`ed socket).
