# Real-time media on the production host - what the ports allow, measured 2026-10-15

> **The question** (user, 2026-10-15): *"le serveur n'a que peu de ports ouverts vers l'exterieur,
> je ne sais pas ce qui est faisable"* - calls (WebRTC through our SFU `call-service`) and
> livestreams (WebRTC SFU, or segments over HTTP) on the Portail-etu host that carries
> `canari-prod`.
>
> **The answer in one line: the binding constraint is not INBOUND, it is OUTBOUND.** Nothing in the
> current call design needs an inbound port beyond 443. But the host cannot send UDP to the
> internet at all, and the SFU can only reach its TURN relay over UDP - so **no call can connect
> from production as built**, and the smallest ask to the DSI is ONE outbound rule, not an inbound
> range. Segmented live over HTTPS works with the ports we have, and its ceiling is bandwidth.

Every measurement below was taken **read-only** on 2026-10-15 between 19:57 and 20:08 UTC (21:57-
22:08 French time, an evening, low-load hour): `ssh <prod-host>` for the host side, the
workstation `OXYGEN` for the outside. No package installed, no container started, no setting
changed, no port scan: each probe names the exact host and port it touched and sends at most three
packets per target. Calling is still held off (`CALLS_ENABLED = false`, [calls](../frontend/modules/calls.md)),
so nothing here was observed on a real call - **the verdicts are about the network path, and a
green path is not a working call.**

The live plan these numbers feed is PR [#1924](https://github.com/emse-students/canari/pull/1924)
(`docs/wiki/frontend/modules/live.md`, branch `docs/live-plan`). This page does not depend on it and
it does not depend on this page: either can merge first, and the link is to the pull request so it
stays valid in both orders.

## 0. The verdict table

| Use | Verdict with the ports we have today | What would change it |
| --- | --- | --- |
| 1:1 call | **BLOCKED** - the SFU leg cannot reach Cloudflare TURN (section 2) | **one outbound rule**: UDP 3478 from `<host-egress-ip>` to Cloudflare TURN (section 3, the ask) |
| Group call | **BLOCKED**, same cause | the same rule; then ~15 people in ONE call at 0.4 Mb/s each before the ~90-107 Mb/s ceiling (section 4) - **unmeasured on a call** |
| Screen share | **BLOCKED**, same cause (it is one more video track on the same path) | the same rule |
| Livestream option A - WebRTC through the SFU | **BLOCKED**, same cause; and every viewer then costs a TURN relay leg billed against Cloudflare's free tier | the same rule; ~36-42 viewers at 2.5 Mb/s before the ceiling |
| Livestream option C - segments over HTTPS 443 via nginx | **FEASIBLE with the current ports**: only 443, which already serves the app | nothing from the DSI; capacity ~36-42 simultaneous viewers at 2.5 Mb/s, ~230-265 at 0.4 Mb/s, measured from ONE outside client (section 4) |
| Reel upload | **FEASIBLE and in production** (reels shipped in `v1.0.0`) - HTTPS 443, bodies kept under 8 MiB because the host WAF drops anything over 10 MiB ([host-waf-body-limit](host-waf-body-limit.md)) | nothing |

## 1. Which ports enter the host, and which leave it

**Question: what reaches the host from the internet?**

Documented, with a control, on 2026-09-24 ([estate-migration](estate-migration.md)):
**only 22, 80 and 443 enter, and 22 only from the campus network** - a container published on a
high port answered from the host itself and timed out from outside. The filter is the School's
network border, not the host. That page also records **TCP 7844 blocked OUTBOUND** (the reason no
Cloudflare Tunnel runs on this host).

Re-read live, 2026-10-15 19:57 UTC:

| Command | Result |
| --- | --- |
| `ip -br addr` | one interface `ens18` carrying `<host-egress-ip>`, `.40` and `.122` (`canari.emse.fr` = `.122`) |
| `ss -lntuH` | public TCP listeners: `22`, `80`, `443` (host nginx), plus `10050` (monitoring agent), `111` (rpcbind) and three high ports, all host-managed. Every Canari port is on `127.0.0.1` (`8081` prod frontend, `3080` dev, `19010/19011` and `19100/19101` Garage). **No UDP listener other than NTP (`123`), rpcbind and two ephemeral sockets** |
| `docker ps --format '{{.Names}} {{.Ports}}'` | no container publishes on a public address; `canari-prod-call-service-1` exposes `3004/tcp` on the Docker network only |
| `docker ps -a \| grep -iE 'turn\|livekit\|janus\|mediasoup'` | **none** - there is no coturn or other media server on the host |
| `systemctl is-active ufw firewalld nftables` | `ufw` inactive, **`firewalld` active**; `firewall-cmd --list-all` answers `Authorization failed` without root, so the zone's rules are **unread** (and are not ours to read with root - DSI host) |
| `firewall-cmd --get-active-zones` | `docker` (the bridges) and `public (default)` |

**Probed from the outside, 2026-10-15 19:58 UTC** (`stun_probe.py` below, from `OXYGEN`):

| Target | Result | Reading |
| --- | --- | --- |
| `tcp canari.emse.fr:443` | connection accepted, then reset by TLS on the STUN bytes | 443 reaches the host (the control) |
| `tcp canari.emse.fr:3478` | timeout | filtered (a closed port on a reachable host would answer RST) |
| `tcp canari.emse.fr:5349` | timeout | filtered |
| `udp canari.emse.fr:3478` | no answer, 3 x 2 s | **inconclusive by construction**: nothing listens there, so silence cannot separate "filtered" from "closed" |

**Verdict: inbound is 80/443 from anywhere, nothing else - confirmed, not changed since 2026-09-24.**
Nothing was ever asked of the DSI for TURN: estate-migration deliberately kept "an inbound UDP range"
out of every request ([section 4 decisions](estate-migration.md#4-the-decisions---taken-with-the-user-2026-09-23-and-2026-09-24-not-to-be-relitigated)). Section 3 shows that the range is not what the current design needs.

**Question: what can the host send OUT?** Measured from the host with the same probe, 2026-10-15
19:58 UTC (`ssh <prod-host> 'python3 -' < stun_probe.py`, Python already on the host), and
the same targets from `OXYGEN` 21 seconds later as the control:

| Target (STUN Binding request) | From the HOST | From OXYGEN (control) |
| --- | --- | --- |
| `udp turn.cloudflare.com:3478` | **no answer, 3 x 2 s** | answered, 15 ms |
| `udp turn.cloudflare.com:53` | **no answer** | answered, 16 ms |
| `tcp turn.cloudflare.com:3478` | **timeout** | answered, 22 ms |
| `tcp turn.cloudflare.com:80` | answered, 25 ms | answered, 35 ms |
| `tls turn.cloudflare.com:5349` | **timeout** | answered, 132 ms |
| `tls turn.cloudflare.com:443` | answered, 120 ms | answered, 113 ms |
| `udp stun.l.google.com:19302` | **no answer** | - |
| `udp stun.cloudflare.com:3478` / `:53` | **no answer** | - |
| `tcp stun.l.google.com:19302` | **timeout** | - |

`turn.cloudflare.com` resolved to `141.101.90.1` from both sides. `ip route get 141.101.90.1` on the
host: `src <host-egress-ip>` via `<gateway-ip>` - **the host leaves from `.67`, not from `canari.emse.fr`'s
`.122`**, which is the address an outbound rule must name. DNS goes to School resolvers
(`/etc/resolv.conf`: `<school-resolver-range>`), so the host's working UDP is internal.

**Verdict: outbound from the host is the web ports only - TCP 80 and 443 pass; UDP to the internet
and every non-web TCP port tested (3478, 5349, 19302, and 7844 in September) are dropped.** Three
independent UDP destinations (Cloudflare TURN, Cloudflare STUN, Google STUN) all fail, so this is a
policy, not one unreachable server.

## 2. Where TURN is, and why the SFU cannot use it

**Question: where does `/api/calls/ice-servers` get its servers?**

- `apps/chat-delivery-service/src/services/calls.service.ts` `getIceServers()` mints short-lived
  credentials from **Cloudflare's hosted TURN** (`CLOUDFLARE_CALLS_API_TOKEN` + `CLOUDFLARE_TURN_KEY_ID`)
  after a group-membership check, and refuses once a monthly budget is spent
  (`CLOUDFLARE_TURN_MONTHLY_BUDGET_GB`, default 950 GB, estimated at 3000 kb/s per device because
  Cloudflare's byte count is not readable). No self-hosted TURN exists anywhere.
- `apps/call-service/src/main.rs` `fetch_cloudflare_ice_servers()` does the same for the SFU's own
  peer connections, once per peer.
- Env on the live containers (`docker exec <c> env`, values redacted to `<set>`): both
  `canari-prod-call-service-1` and `canari-prod-chat-delivery-service-1` carry
  `CLOUDFLARE_CALLS_API_TOKEN` and `CLOUDFLARE_TURN_KEY_ID` set, `TURN_URL` empty. The call-service
  log since its start (`2026-10-15T06:33:08Z`, image `v1.2.8`) is ONE line, `Call service listening on
  0.0.0.0:3004` - **no peer has ever fetched ICE servers on this host**, consistent with calls being
  off.

**Question: what does the design need from the network?** Both sides are **relay-only**:
the browser sets `iceTransportPolicy: 'relay'` (`frontend/src/lib/services/CallService.ts`), and the
SFU sets `RTCIceTransportPolicy::Relay` whenever a TURN URL is configured (`main.rs`,
`create_peer_connection`). So every packet goes client -> Cloudflare TURN <- SFU. **The SFU never
accepts a connection from the internet**: its only inbound traffic is the signalling WebSocket,
which already rides 443 (host nginx -> container nginx `location /api/call` -> `call-service:3004`,
rewritten to `/ws`, 3600 s timeouts - `infrastructure/local/Dockerfile.frontend`). **That is why no
inbound port is needed** - Cloudflare TURN is reached OUTBOUND by both the phone and the SFU.

**Question: which TURN transports can the SFU use?** Only one. `filter_urls_for_sfu()` in `main.rs`
drops every `turns:`, every `?transport=tcp`, and ports 53, 80 and 443, keeping only `turn:` over
UDP on 3478. That filter reflects the library, not a choice: in `webrtc-ice` 0.17.2 (the version in
`apps/call-service/Cargo.lock`), `gather_candidates_relay` handles `ProtoType::Udp` + `SchemeType::Turn`
only, and the TCP and TLS cases are a commented-out `TODO` (`src/agent/agent_gather.rs` lines 777-797);
ICE-TCP host candidates are likewise a commented-out `TODO` (lines 270-287), so the SFU gathers UDP
host candidates and nothing else.

**Verdict: BLOCKED.** The single transport the SFU can use (UDP 3478 to Cloudflare) is the one the
School border drops outbound (section 1). The two that pass (TCP 80, TLS 443) are the two the
library cannot speak. The phone side is not the problem (section 6).

## 3. The SFU's network needs, and the minimal ask to the DSI

| Option | Ports | Who asks | Code change | Reading |
| --- | --- | --- | --- | --- |
| **A. Outbound UDP 3478 from `<host-egress-ip>` to Cloudflare TURN** | none inbound | DSI, one outbound rule | **none** - the design already works this way | **the minimal ask.** Cloudflare documents its TURN anycast ranges as `141.101.90.0/24` and `162.159.207.0/24` (from Cloudflare's TURN documentation, **not verified here** beyond `141.101.90.1` resolving); the relay ports Cloudflare allocates on its side do not matter to our border, because the SFU only ever talks to `:3478` |
| B. Teach the SFU TURN over TLS 443 (passes today) | none | nobody | port the SFU to a stack whose TURN client speaks TCP/TLS (webrtc-rs 0.17 does not; whether the 0.20 `rtc` rewrite does is **unknown**, and that port is already a separate piece of work, [calls](../frontend/modules/calls.md#the-webrtc-020-port-measured-2026-09-15)) | no DSI ticket, but a TCP relay leg under real-time media adds head-of-line stalls; **unmeasured** |
| C. Drop relay-only on the SFU: inbound UDP media range | an inbound UDP range (e.g. 10 000-10 100) to `<canari-public-ip>` | DSI, the "refused more easily" kind | relay policy off on the SFU, a fixed port range and a 1:1 NAT address in `SettingEngine` | the ask estate-migration deliberately never made; buys a Cloudflare-free server leg and nothing the user asked for |
| D. Self-hosted TURN (coturn) on the host | 3478 UDP/TCP and a relay range inbound, or TURN-TLS sharing 443 | DSI, plus an install on a DSI host | config only | **a new install on the DSI's host**, forbidden without their written agreement (CLAUDE.md); and 443 is taken by the host nginx, so TURN-TLS on 443 would need an SNI/ALPN stream split of THEIR nginx |

**Recommendation recorded, decision the user's: Option A**, worded for the ticket as *"autoriser en
sortie UDP 3478 depuis <host-egress-ip> vers 141.101.90.0/24 et 162.159.207.0/24 (relais TURN
Cloudflare, appels audio/video de Canari)"*. It is an outbound rule to two named /24, which is a
different and smaller ask than the inbound range the September request avoided. It does NOT make
calls work by itself: the by-hand call owed by [calls](../frontend/modules/calls.md) is still the
proof.

## 4. Network capacity

**The interface** (`/sys/class/net/ens18/...`, 2026-10-15 19:57 UTC): a `virtio_net` vNIC
(`vendor 0x1af4`), `speed = -1` - **a VM interface reports no link speed**, so the capacity is
whatever the hypervisor and the School link give it. `ethtool` and `vnstat` are not installed (not
installed by us either). No DSI link cap is documented anywhere in this repository.

**Current use** (`/proc/net/dev` on `ens18`, read 60 s apart, 20:03:24-20:04:24 UTC): TX
1 481 636 B = **0.20 Mb/s out**, RX 997 769 B = 0.13 Mb/s in. Since boot (8 d 13 h 01 min, 738 060 s):
TX 76.05 GB = **0.82 Mb/s average out**. The box is nearly idle on the network.

**Throughput from outside** (`bun throughput.mjs`, below), downloading an existing 2 125 099-byte
immutable static asset, `https://canari.emse.fr/_app/immutable/assets/mls_wasm_bg.DF59BVmd.wasm`
(served by the container nginx behind the host nginx and its CrowdSec module), `accept-encoding:
identity`, 2026-10-15 20:07 UTC. Control first, to show the workstation's own link is not the limit:

| Run | Requests | Rate |
| --- | --- | --- |
| control: `speed.cloudflare.com/__down?bytes=25000000`, 1 connection | 1 x 25 MB | **244 Mb/s** |
| 1 connection, run 1 / 2 / 3 | 5 x 2.1 MB each | **35.6 / 39.7 / 37.2 Mb/s** |
| 5 parallel connections | 15 x 2.1 MB | **72.2 Mb/s** |
| 20 parallel connections, run 1 / 2 | 40 x 2.1 MB each | **106.7 / 91.2 Mb/s** |

Every request answered `200`, none failed. Total downloaded: ~245 MB.

**Reading.** One connection is RTT-bound (~37 Mb/s); the aggregate flattens at **~90-107 Mb/s** from
5 to 20 connections while the workstation could take 244. **The cause of that ceiling is unknown**:
a ~100 Mb/s shaping on the VM or the School link fits it, so does the path between this workstation
and the School. It is ONE client at ONE hour. Campus viewers on the School LAN may not cross the
border at all, and that path is **unmeasured**.

**What it means in viewers, at the measured ~90-107 Mb/s:**

| Per-viewer bitrate | Viewers before the ceiling |
| --- | --- |
| 2.5 Mb/s (a 720p reel) | **~36-42** |
| 0.4 Mb/s (audio + low video) | **~225-265** |

**For a group call through the SFU** (once section 3 is answered): with N participants each sending
0.4 Mb/s, the SFU receives N x 0.4 and sends N x (N-1) x 0.4 Mb/s - **~15 participants in one call**
reach 84 Mb/s. Every byte also crosses Cloudflare TURN twice (phone leg and SFU leg), against the
950 GB monthly budget the code enforces. The SFU's CPU cost per stream is **unmeasured**.

## 5. nginx as the segment server for live option C

**Question: can nginx serve live segments, and how many requests can it take?**

- The **container** nginx already serves immutable assets with `Cache-Control: public,
  max-age=31536000, immutable` (`infrastructure/local/Dockerfile.frontend`, measured on the asset
  above with `curl -sI`), so segments with content-addressed names fit the same pattern; a playlist
  would want a short `max-age`. **No `proxy_cache` is configured anywhere** - in the host's
  `/etc/nginx/nginx.conf` or `sites-enabled/canari*.conf` (`grep proxy_cache`, empty), nor in the
  container. If segments are served from Garage through `media-service`, a `proxy_cache` (or writing
  segments to a volume the container nginx serves directly) is the work item.
- **Host nginx limits**: `worker_processes auto` on 4 vCPU (`QEMU Virtual CPU version 2.5+`, `nproc` 4),
  **`worker_connections 768`** - about 3 000 connections in all, and each proxied viewer holds two
  (client + upstream), so **~1 500 concurrent connections across EVERY site on the host**. That file
  is the host's, not Canari's: raising it is a DSI conversation.
- **CrowdSec runs inside the host nginx** (`/etc/nginx/conf.d/crowdsec_nginx.conf`, a Lua bouncer).
  Many viewers behind one campus NAT address polling a playlist every few seconds could look like a
  crawl to it. **Unknown**, and worth a question to the DSI before a live event.
- **Headroom now** (2026-10-15 20:04 UTC): load average `0.35 0.72 0.79` on 4 cores; `free -m`
  6 129 MB available of 11 967 (1 217 MB swap in use); `docker stats --no-stream` tops at
  `canari-prod-frontend-ssr-1` 25 %, everything else under 3 %. **Disk: `/` 75 % used, 11 GB free** -
  the threshold the user set for the image prune ([backlog](../backlog.md#decided-by-the-user-on-2026-10-11)),
  so a live recording kept on this disk competes with it.
- **Request burst** (`bun throughput.mjs https://canari.emse.fr/_app/version.json 20 10`, 2026-10-15
  20:07:53 UTC, **200 requests, 20 concurrent**, a 37-byte file): 200 x `200` in 1.57 s, **~127
  requests/s**. That is bound by this client's round trip (~157 ms per request per connection,
  including TLS setup), not by nginx, so it is a **floor** on what nginx sustains, not its ceiling.

**Verdict: FEASIBLE with the current ports.** Bandwidth (section 4) binds long before nginx does.

## 6. Phones on UDP-hostile networks

From the code: the client gets the **unfiltered** Cloudflare list (`CallService.ts` maps every entry
of `/api/calls/ice-servers` as returned), which carries UDP 3478/53, TCP 3478/80 and TLS 5349/443.
A phone on a network that drops UDP - many corporate or campus Wi-Fi networks, some mobile carriers
- can therefore still reach Cloudflare TURN over **TLS on 443**, which looks like ordinary HTTPS.
From `OXYGEN` all six transports answered (section 1). **The School's own Wi-Fi and the French
mobile carriers were not measured** - that needs a phone on each, and is not the blocker: the SFU
leg is (section 2).

Live option C has no UDP at all: segments are HTTPS on 443, the most permissive path any phone has.

## 7. Unverified, and how each would be settled

| Unverified | Settled by |
| --- | --- |
| Whether the ~100 Mb/s ceiling is the host's or this path's | the same `throughput.mjs` run from a campus machine and from a phone on 4G |
| Cloudflare's TURN address ranges | Cloudflare's TURN documentation, read at the time of the ticket |
| What `firewalld`'s `public` zone allows | the DSI (root on their host) |
| Whether CrowdSec bans many viewers behind one NAT | the DSI, or a staged test agreed with them |
| SFU CPU per forwarded stream | the by-hand call [calls](../frontend/modules/calls.md) already owes, with `docker stats` beside it |
| Whether webrtc-rs 0.20 speaks TURN over TLS (option B) | reading the `rtc` crate's TURN client at the time of the port |

## The two probes

Both lived in a scratch directory and are not committed; they are described here precisely enough to
be rewritten in a few minutes and the numbers re-taken.

`stun_probe.py` sends one STUN Binding request (RFC 5389: type `0x0001`, magic cookie
`0x2112A442`, 12 random transaction bytes) per attempt - at most three per UDP target, one per
TCP/TLS target - and accepts only a Binding success (`0x0101`) echoing the transaction id. Targets
are `turn.cloudflare.com` on udp 3478/53, tcp 3478/80 and tls 5349/443, plus any `kind:host:port`
on the command line. Run on the host as `ssh <prod-host> 'python3 -' < stun_probe.py`.

`throughput.mjs` (bun) runs N concurrent workers, each fetching one URL M times with
`accept-encoding: identity`, and prints the status counts, bytes, elapsed time and Mb/s. Invoked as
`bun throughput.mjs <url> <concurrency> <per-worker>`.
