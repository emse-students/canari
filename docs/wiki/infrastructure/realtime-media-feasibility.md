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
22:08 French time, an evening, low-load hour): `ssh <prod-host>` for the host side, a
workstation on a home line for the outside. No package installed, no container started, no setting
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
| `ip -br addr` | one interface carrying the host's egress address and the sites' public addresses; `canari.emse.fr` is NOT the egress address |
| `ss -lntuH` | public TCP listeners: `22`, `80`, `443` (host nginx), plus host-managed services. Every Canari port is on `127.0.0.1` (`8081` prod frontend, `3080` dev, `19010/19011` and `19100/19101` Garage). **No Canari UDP listener** |
| `docker ps --format '{{.Names}} {{.Ports}}'` | no container publishes on a public address; `canari-prod-call-service-1` exposes `3004/tcp` on the Docker network only |
| `docker ps -a \| grep -iE 'turn\|livekit\|janus\|mediasoup'` | **none** - there is no coturn or other media server on the host |
| host firewall | the host runs its own firewall, managed by the DSI; its rules are theirs and are not reproduced here |

**Probed from the outside, 2026-10-15 19:58 UTC** (`stun_probe.py` below, from the workstation):

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
the same targets from the workstation 21 seconds later as the control:

| Target (STUN Binding request) | From the HOST | From the workstation (control) |
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
host: `src <host-egress-ip>` via `<gateway-ip>` - **the host leaves from its own egress address, not
from `canari.emse.fr`'s**, which is the address an outbound rule must name. DNS goes to School
resolvers, so the host's working UDP is internal.

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

**The interface** (`/sys/class/net/<if>/...`, 2026-10-15 19:57 UTC): a virtual NIC, `speed = -1` -
**a VM interface reports no link speed**, so the capacity is
whatever the hypervisor and the School link give it. `ethtool` and `vnstat` are not installed (not
installed by us either). No DSI link cap is documented anywhere in this repository.

**Current use** (`/proc/net/dev` on that interface, read 60 s apart, 20:03:24-20:04:24 UTC): TX
1 481 636 B = **0.20 Mb/s out**, RX 997 769 B = 0.13 Mb/s in. Since boot (8 d 13 h 01 min, 738 060 s):
TX 76.05 GB = **0.82 Mb/s average out**. The box is nearly idle on the network.

**Throughput from outside** (`bun throughput.mjs`, below), downloading an existing 2 125 099-byte
immutable static asset, `https://canari.emse.fr/_app/immutable/assets/mls_wasm_bg.DF59BVmd.wasm`
(served by the container nginx behind the host proxy and its security tooling), `accept-encoding:
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
  would want a short `max-age`. **No `proxy_cache` is configured anywhere** - in the host proxy
  nor in the container. If segments are served from Garage through `media-service`, a `proxy_cache` (or writing
  segments to a volume the container nginx serves directly) is the work item.
- **Host proxy limits**: the host proxy has **a host-wide connection budget set by the DSI**, shared
  by every site on the host, and each proxied viewer holds two connections (client + upstream);
  Canari keeps its share under a quarter of it. That configuration is the host's, not Canari's:
  raising it is a DSI conversation.
- **The host's security tooling sits in front of every site.** Many viewers behind one campus NAT
  address polling a playlist every few seconds could look like a crawl to it. **Unknown**, and worth
  a question to the DSI before a live event.
- **Headroom now** (2026-10-15 20:04 UTC): load average `0.35 0.72 0.79` on 4 cores; `free -m`
  6 129 MB available of 11 967 (1 217 MB swap in use); `docker stats --no-stream` tops at
  `canari-prod-frontend-ssr-1` 25 %, everything else under 3 %. **Disk: `/` 75 % used, 11 GB free**,
  so a live recording kept on this disk competes with everything else on it.
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
From the workstation all six transports answered (section 1). **The School's own Wi-Fi and the French
mobile carriers were not measured** - that needs a phone on each, and is not the blocker: the SFU
leg is (section 2).

Live option C has no UDP at all: segments are HTTPS on 443, the most permissive path any phone has.

## 7. Unverified, and how each would be settled

| Unverified | Settled by |
| --- | --- |
| Whether the ~100 Mb/s ceiling is the host's or this path's | the same `throughput.mjs` run from a campus machine and from a phone on 4G |
| Cloudflare's TURN address ranges | Cloudflare's TURN documentation, read at the time of the ticket |
| What the host's own firewall allows | the DSI |
| Whether the host's security tooling bans many viewers behind one NAT | the DSI, or a staged test agreed with them |
| SFU CPU per forwarded stream | the by-hand call [calls](../frontend/modules/calls.md) already owes, with `docker stats` beside it |
| Whether webrtc-rs 0.20 speaks TURN over TLS (option B) | reading the `rtc` crate's TURN client at the time of the port |

## 8. What works with no port opened by the DSI (measured 2026-10-16)

> **The question** (user, 2026-10-16): *"Il faut que la DSI ouvre des ports ? On ne peut pas faire
> sans ? Peut-etre avec le TURN Cloudflare, mais c'est moins bien ?"*
>
> **The answer: no port is needed IF the media never touches this host.** Sections 1-3 measured that
> the HOST cannot reach a TURN relay; the CLIENTS can, over every transport (table 8.1). The one
> design that needs the DSI is the one we have - an SFU on the host that must leave over UDP. Move
> the media off the host (peer to peer for 1:1, a managed SFU for groups) and the host only carries
> signalling over the 443 it already serves. Cloudflare TURN is not "less good" as a relay: it is
> anycast to the nearest PoP (9-16 ms measured), and it is only used when a direct path fails.

### 8.1 What was measured, and from where

Every probe below is read-only: STUN Binding requests (`stun_probe.py`, section "The two probes"),
or a browser page that builds one `RTCPeerConnection` per server URL and gives TURN a deliberately
WRONG credential - so **a TURN error 400 means the relay was reached over that transport and
answered**, and no credential was minted or printed. The page and the raw outputs are kept
outside the repository.

| Where, 2026-10-16 UTC | UDP 3478 (STUN/TURN) | UDP 53 | UDP 443 | TCP 3478 / 80 | TLS 5349 / 443 | Candidate types |
| --- | --- | --- | --- | --- | --- | --- |
| **Portail-etu host** (its egress address), 00:50 re-run | **no** | **no** | **no** (00:49) | no / yes | no / yes | - (server) |
| **Old `canari` VM** (NAT via the School network), 00:48 | **yes, 16 ms** (Google STUN too) | no | no | yes / yes | yes / yes | - (server) |
| Workstation, raw STUN, home line, 00:48 | yes, 10 ms | yes | yes | yes / yes | yes / yes | - |
| Workstation, Chrome 155, 00:54 | yes (TURN reached) | **no answer** (raw STUN on 53 from the same PC did answer - a Chrome-on-Windows quirk, not the network) | not tried | reached / reached | reached / reached | host/udp, srflx/udp |
| Mi 9T, Chrome 154 on Android 10, home Wi-Fi, 00:52 | yes (TURN reached) | yes | not tried | reached / reached | reached / reached | host/udp, srflx/udp |
| Mi 9T on **mobile data** | **not measured** - no SIM in the phone (`gsm.sim.state ABSENT`) | | | | | |
| iPhone 12, Safari | **not measured** - the page must be served on the LAN or a public origin, and serving it on the LAN was refused by the session's permission policy; a public copy is one step | | | | | |
| Campus Wi-Fi, a French 4G carrier | **not measured** - a human on campus, a SIM | | | | | |

**Reading.** The two clients measured reach Cloudflare TURN over all six transports and get a
server-reflexive (`srflx`) candidate, i.e. a direct peer-to-peer path is at least attempted. **That
is ONE home network**; whether campus Wi-Fi and the carriers leave UDP open is exactly what the
missing rows settle (the page is ready for them). A client that loses UDP still has TLS 443 to
Cloudflare, the transport the host's own border lets through.

**And one fact that changes the cost of option C:** dev's `chat-delivery-service` and
`call-service` carry **no** `CLOUDFLARE_CALLS_API_TOKEN` / `CLOUDFLARE_TURN_KEY_ID` (prod carries
both; `docker exec ... env`, values never printed). `GET /api/calls/ice-servers` on dev therefore
answers 503, so **no credentialed TURN allocation was measured** - only reachability. Giving dev the
pair (or a dev-only TURN key) is a one-off for the user, owed before WP-C0's allocation half.

### 8.2 The four paths, compared

**(A) 1:1 calls peer to peer - FEASIBLE with no DSI change; a client change.**

- **Today the SFU is mandatory, even for two people.** `CallService.connectToSfu` always opens
  `wss://<origin>/api/call`, sends `Join`, then `initPeerConnection` offers to the SFU, which
  terminates the peer connection and re-sends the media (`apps/call-service/src/main.rs`,
  `SignalMessage` = `Join | Joined | Offer | Answer | IceCandidate`, no peer addressing). There is
  no P2P mode in the code.
- **What a P2P mode needs**, smallest first:
  1. **Signalling between the two peers.** The cheapest is to keep `call-service` as a SIGNALLING
     RELAY for a two-person room: it already authenticates `Join` with the room token, so it
     forwards `Offer`/`Answer`/`IceCandidate` to the other peer instead of terminating them, and
     opens no peer connection itself (no webrtc-rs on the media path at all). The alternative,
     signalling as MLS application messages over chat-gateway, is E2E but adds ordering and latency
     work for no gain - the SDP carries no secret the frame key depends on.
  2. **The client** offers to the other peer (one polite / one impolite role for glare), and sets
     `iceTransportPolicy` to `all` instead of `relay`, so ICE tries host, then `srflx`, then the
     Cloudflare relay last. **Privacy trade, a decision for the user:** `all` lets each party learn
     the other's public IP address; keeping `relay` makes every call go through Cloudflare (still
     no host involvement, still no DSI) at TURN cost and one extra hop.
  3. **E2E is unchanged.** `RTCRtpScriptTransform` sits on the sender and the receiver of the SAME
     `RTCPeerConnection` whoever is on the other side, and the keys are still
     MLS exports, one per direction since 2026-10-21 (`exportSecret(groupId, 'mls-webrtc-media-v2', '<callId>|<sender role>', 32)`). P2P is in fact the simpler case: DTLS-SRTP
     already ends at the other phone, and a TURN relay cannot read DTLS either. Every E2E defect the
     revival plan lists (whole-frame encryption under H.264, the asymmetric legacy path) is the same
     in both modes.
- **Quality.** Direct is the lowest latency possible (no hop) and costs nothing. When NAT forbids a
  direct path - symmetric NAT and carrier-grade NAT are common on mobile networks - ICE falls back to
  Cloudflare TURN, which adds one anycast hop (9-16 ms measured to it from here) and is billed.
  **What share of mobile calls will need the relay is unmeasured here** (published figures for
  WebRTC are of the order of one call in five, not verified for French carriers); the
  `[CALL_REPORT]` `pair=` field of the revival plan measures it on our own calls.
- **Budget.** The 950 GB estimator in `calls.service.ts` assumes EVERY call is relayed at
  3000 kb/s per device (~700 device-hours a month). In P2P only relayed calls cost, so the estimator
  must learn which pair was selected (from the client report) or it refuses calls long before the
  real spend.

**(B) Group calls, screen share and live through a MANAGED SFU (Cloudflare Realtime SFU) -
FEASIBLE with no DSI change; the largest code change.**

- **The host only makes HTTPS calls**: the backend holds the SFU app secret and calls
  `https://rtc.live.cloudflare.com/v1/apps/{appId}/...`; the clients do ICE with Cloudflare
  directly ([connection patterns](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/)).
  Measured: the host reaches `rtc.live.cloudflare.com` over 443 (`curl`, HTTP answer in 1.0 s,
  2026-10-16). The host's uplink, its ~100 Mb/s ceiling (section 4) and its 15-person arithmetic
  stop mattering - media never crosses it.
- **Price** ([SFU pricing](https://developers.cloudflare.com/realtime/sfu/pricing/)): 1 000 GB
  of egress free per month, **shared** with TURN, then $0.05/GB; ingress is free; **TURN is free
  when used together with the SFU** ([TURN](https://developers.cloudflare.com/realtime/turn/)).
  A live at 2.5 Mb/s costs ~1.1 GB per viewer-hour, so 40 viewers for one hour is ~45 GB.
- **E2E.** Cloudflare's own E2EE demo (Orange Meets) encrypts frames with MLS in a WASM worker - the
  shape of ours - and reports the SFU needed no change
  ([blog, 2025-06-26](https://blog.cloudflare.com/orange-me2eets-we-made-an-end-to-end-encrypted-video-calling-app-and-it-was/)).
  It keeps the first bytes of each VP8 frame in clear; **whether the SFU itself needs them
  (keyframe detection, simulcast) is not in the product docs - UNVERIFIED**, and it is the same
  header-in-clear question as the revival plan's WP-C3.
- **Accounts.** An SFU is a separate Realtime "app" (App ID + App Secret), created in the
  dashboard; **our TURN key does not give us one** - a one-off for the user, plus two secrets.
  Client transports to the SFU (UDP, TCP, TLS 443) are not stated on the pages read - UNVERIFIED,
  settled by the same probe page once an app exists.
- **Limits** ([limits](https://developers.cloudflare.com/realtime/sfu/platform/limits/)): 64 tracks
  per API call, 50 API requests/s per session, no stated participant cap; simulcast is listed.
- **Code.** The client's signalling moves from our WebSocket to sessions/tracks calls proxied by our
  backend, and the multi-stream client of WP-C11 is owed in any case. In exchange the Rust SFU, its
  six never-placed webrtc majors and the 0.20 rewrite all leave the project.

**(C) Keep the in-repo Rust SFU without the DSI.**

- **C1 - TURN over TCP/TLS 443 from the host: BLOCKED in the library, every version.** 0.17.2 has
  the TCP/TLS relay as a commented-out `TODO` (section 2), and **0.20.5 refuses them explicitly**:
  `webrtc-0.20.5/src/peer_connection/transports/turn_relayer.rs` logs `Skipping unsupported secure
  TURN url` and `Skipping unsupported non-UDP TURN url` (read from the crate source in the local
  cargo registry, 2026-10-16). Only a fork with our own TURN-over-TCP client would do it - not a
  realistic path. UDP 443 is no exit either: the host drops it (8.1).
- **C2 - the SFU on the old `canari` VM: the NETWORK works, the VM's FUTURE does not.** From that VM
  UDP 3478 reaches Cloudflare TURN and STUN in 14-21 ms (8.1), so the current relay-only design
  would connect from there **with no code change to the media path**. It is idle (6 vCPU, 16 GB,
  load 0.00), `call-service` is stateless (env only: `JWT_SECRET`, `CALL_ROOM_SECRET`, the TURN pair,
  `PORT`), and the VM already runs the Cloudflare connector, so its WebSocket can be published as a
  tunnel ingress on a `canari-emse.fr` name with no inbound port. **Against it:** that VM is
  documented as the ROLLBACK, kept "for a while" ([estate-migration](estate-migration.md)); giving it a
  permanent role reverses that decision. Its UDP exit is a policy of the School network we did not
  ask for and can lose without notice. Both legs still relay through TURN (double the budget of P2P),
  and the 0.17 "never placed a call" risk is untouched.

**(D) The DSI ask (section 3, option A) - the fallback.** One outbound rule: UDP 3478 from
`<host-egress-ip>` to Cloudflare TURN. Cloudflare's TURN page lists no fixed ranges; its guidance is to
allowlist what `turn.cloudflare.com` resolves to, fixed addresses being an enterprise-plan matter -
**so the two /24 of section 3 stay UNVERIFIED** and the ticket should name the hostname as well. It
is needed ONLY if the in-repo SFU stays on this host.

### 8.3 Recommendation, feature by feature

| Feature | Recommended path | DSI | Quality | Cost |
| --- | --- | --- | --- | --- |
| **1:1 audio/video** | **(A) peer to peer**, Cloudflare TURN as last resort, signalling over the existing `/api/call` WebSocket | none | best: direct, no hop; relayed calls +1 anycast hop | only relayed calls are billed; the estimator must learn which |
| **Group call (3+)** | **(B) managed SFU** | none | one hop to the nearest PoP for everyone, no host uplink ceiling | 1 000 GB/month free shared with TURN, then $0.05/GB; TURN free with the SFU |
| **Screen share** | follows its call: (A) in a 1:1, (B) in a group | none | as its call | as its call |
| **Live, option A (WebRTC)** | **(B) managed SFU** | none | sub-second | ~1.1 GB per viewer-hour at 2.5 Mb/s |
| Live, option C (segments) | unchanged: HTTPS on the host (section 5) | none | seconds of delay | the host's ~100 Mb/s |
| Keep the Rust SFU | (C2) on the old VM, or (D) the DSI rule | (D) only | as today | both legs relayed |

**Is TURN "less good"?** Only as the PATH OF EVERY CALL, as today: two relayed legs plus an SFU hop.
As the last resort of a peer-to-peer call it is the standard design, and Cloudflare's is close
(anycast) and reachable on TLS 443 from networks that block UDP. **What decides the order of work
is (A): it removes the DSI from the 1:1 revival and needs no new provider account.** (B) and (C2) are
choices for WP-C4, the revival plan's decision step.

## 9. Probes of 2026-10-16: servers

> **The question** (user, 2026-10-16): settle with REAL probes, not readings, how calls and live can
> run without Cloudflare or the DSI - this section is the SERVER half (the clients and TURN are
> section 8.1). Taken 09:41-09:51 UTC from the workstation (a home line). Production host: read-only
> commands only (nothing written, nothing listened). Old VM: read-only, plus ONE listener for 90 s,
> recorded below. The raw evidence is kept outside the repository.

| # | Question | Method | Result | Verdict |
| --- | --- | --- | --- | --- |
| 1a | Which inbound ports does the HOST itself accept? | the host's listeners (`ss -tulpn`), read-only | public TCP 22, 80 and 443, plus host-managed services the host's own firewall keeps closed to the internet; every Canari port on `127.0.0.1`; **no UDP 443 listener, so no HTTP/3** | **22/80/443 - the host and the School border agree** (border measured 2026-09-24 and section 1) |
| 1b | Public path of each front door | `curl -w '%{remote_ip}'` x5, response headers | `canari.emse.fr` -> `<canari-public-ip>`, `Server: nginx`, no `cf-ray`: **host nginx directly, no tunnel**. `dev.canari-emse.fr` -> a Cloudflare anycast address, `Server: cloudflare`, `cf-ray ...-MRS`: **edge -> tunnel -> host** | as documented ([estate-migration](estate-migration.md)) |
| 1c | Is the host's OUTBOUND UDP drop the host's own rule? | the host's outbound rules, read-only | nothing filters outbound on the host | **the drop of section 1 is the School border, not the host** - nothing on the host to change, and nothing a host-side setting would fix |
| 2a | Prod egress on 443, from outside | `bun throughput.mjs` on the 2 125 099-byte `mls_wasm_bg.*.wasm`, identity encoding; control `speed.cloudflare.com` 25 MB = **279 Mb/s** | 1 conn x3: **41.3 Mb/s**; 5 conns x2: **66.7 Mb/s**; 20 conns x1: **99.1 Mb/s** (TTFB median 42 / 245 / 305 ms); all `200` | **same ~100 Mb/s ceiling as 2026-10-15** (section 4), a second hour, same client |
| 2b | Dev egress, same test | same, dev's own wasm | 38.9 / 160.5 / **182.1 Mb/s** - but `cf-cache-status: HIT`: **those numbers are Cloudflare's cache, not our host**. Re-run with a unique query per request (`MISS`, through the tunnel): 1 conn **17.8**, 5 conns **18.7**, 20 conns **18.7 Mb/s** (TTFB median 2.35 s at 20) | **the tunnel path caps at ~19 Mb/s whatever the parallelism** - five times below the direct path; live segments must not be served through the old VM's tunnel |
| 2c | Latency to each front door | `curl -w` x5 on `/_app/version.json` | prod: TCP connect **~38 ms**, TLS done ~100 ms, TTFB ~135 ms. Dev: connect ~16 ms (to the CDN), TTFB ~55-73 ms (edge-cached file) | the direct path is ~38 ms RTT from here; a segment's first byte is ~1 RTT after a warm connection |
| 3a | Who administers the old VM, and what is it? | `systemd-detect-virt`, `id`, `ip route`, [cloudflare-edge](cloudflare-edge.md#the-tunnel-drops-in-the-22h-band-and-nothing-on-this-page-can-fix-it) | a container on the School's virtualisation, on a private network whose default route is **the School's border firewall**, with a public NAT address; its own ruleset is accept-all (Docker's chains only) | **the box is ours, its network is not**: any inbound path is a NAT rule on the School's firewall, i.e. a DSI request - the same as the host |
| 3b | Can the old VM RECEIVE from the Internet on a high port? | `listen_probe.py` (below) on the VM, TCP+UDP `47391`, **90 s, 09:46:53-09:48:23 UTC, exited by itself** (`ss` afterwards: 0 sockets on 47391). From the workstation `send_probe.py <old-vm-public-ip> 47391`: 1 TCP connect + 3 UDP datagrams. Control from the VM to `<private-ip>:47391` | Workstation: **TCP timeout, UDP no reply x3, and the listener logged NOTHING from outside**. Control: TCP connected and UDP answered | **NO inbound, TCP or UDP** - by construction (no DNAT on the border) and now measured. A self-hosted coturn or a non-relay SFU there needs the DSI exactly as on the host |
| 3c | Can it SEND UDP? | section 8.1 (STUN to Cloudflare TURN and Google) | yes, 14-21 ms | **outbound UDP works from the VM** (the School's policy differs by subnet, and we did not ask for it - section 8.2 C2) |
| 3d | Capacity for a coturn or SFU | `nproc`, `free -m`, `uptime`, `df`; `curl` to `speed.cloudflare.com` from the VM | 6 cores, 16 GB (16.1 GB available), load 0.00, disk 18 % (98 GB free), **no container running**. Download 389-487 Mb/s. **Upload 4.0-4.4 Mb/s on a single TCP flow** (three runs, 10-25 MB; the workstation's control upload to the same endpoint: 56 Mb/s); a 20 MB stream VM -> workstation over ssh: 6.8 Mb/s | CPU and RAM are plenty; **the UPLINK is the weak point** - ~4 Mb/s per TCP flow, ~19 Mb/s aggregate through the tunnel (2b). Whether the cap is per flow (four tunnel connections x ~4.5 would fit 19) or for the box, and what UDP gets, is **not measured** - an SFU there should be assumed to have ~15-20 Mb/s of egress until it is |
| 3e | Is it the documented rollback? | [estate-migration](estate-migration.md) | **no longer**: the 23 Canari containers and 10 volumes were destroyed 2026-09-25 (*"Tout supprimer maintenant"*), and since 2026-10-18 the older project-team machines are out of scope ([estate-migration](estate-migration.md#two-older-project-team-virtual-machines-are-out-of-scope-decided-2026-10-18)); what it carried on 2026-10-16 is in the private operations notes | not a rollback; a permanent role there (8.2 C2) needs a new decision |
| 4a | WebSocket through the host nginx | the host proxy's behaviour, client code | WebSocket upgrades are forwarded; **the host proxy closes a socket idle for 60 s**, in front of the container's 3600 s on `/api/call` and 120 s on `/api/ws`. The web client's heartbeat is every 8 s (`WebMlsService.ts`), so `/api/ws` never idles 60 s. Upgrade without a token answers `401` on both `/api/ws` and `/api/call` (auth before upgrade), so **an idle socket could not be held open unauthenticated to measure the cut** | **WS works** (it carries chat today); a call-signalling socket must ping under 60 s or the host nginx closes it - the container's 3600 s is not what binds |
| 4b | Long-lived chunked streaming (live segments) | the host proxy's behaviour, `Dockerfile.frontend` | host proxy: **buffers responses**, over HTTP/2, behind the host's security tooling. Container: `proxy_buffering off` server-wide, `tcp_nodelay on`, `client_max_body_size 100m`, `/api/media` `proxy_read_timeout 300s`. The container nginx CONSUMES an upstream `X-Accel-Buffering` header (nginx does not forward `X-Accel-*`), so a backend cannot unbuffer the host from inside | **segments as ordinary files: FEASIBLE today** (that is what 2a measured). **A single long chunked response (LL-HLS part streaming, SSE-style) is NOT safe as configured**: the host buffers it and cuts any gap over 60 s; fixing it is either `add_header X-Accel-Buffering no` on that container location (ours, no DSI) or a line in the host vhost (the DSI's file). **Not measured end to end** - no unauthenticated streaming endpoint exists |

**What was NOT tested, and why.**

- **The Mi 9T against the old VM's listener**: it sits on the same home Wi-Fi as the workstation, and the
  inbound result is decided by the School border's NAT, not by the client - a second client on the
  same line adds no information. A phone on mobile data would (the bench Mi 9T has no SIM, 8.1).
- **An idle WebSocket held past 60 s** and **a slow chunked response through the host**: both need
  an authenticated session or an endpoint we would have to deploy; the verdicts in 4a/4b are read
  from configuration, not observed.
- **UDP egress capacity of the old VM** (what a TURN/SFU leg would actually use) and **whether the
  ~4 Mb/s is per flow**: needs a UDP sink we control on the Internet side, which does not exist.
- **Prod throughput from campus or 4G**: same open item as section 7, unchanged.
- **The School border firewall's rules** (as opposed to the host's own): that firewall is the
  School's, outside every access this project holds.

**What this changes in section 8.** It confirms (A) and (B): neither needs an inbound port, and the
host's own rules are not the obstacle anywhere. It weakens **C2** (the SFU on the old VM): the
network lets its UDP out, but the box receives nothing from outside, uploads ~4 Mb/s per flow and
~19 Mb/s through its tunnel, and also carried dev - a group call's SFU forwarding
N x (N-1) x 0.4 Mb/s would hit that ceiling at about 7 people. And it bounds **live option C**: serve
segments from `canari.emse.fr` directly (~100 Mb/s), never through the tunnel (~19 Mb/s).

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
`bun throughput.mjs <url> <concurrency> <per-worker>`. Section 9 added `BUST=1`, which appends a
unique query to each request so a Cloudflare-fronted name answers `MISS` and the bytes come from
our host, not the edge cache.

Section 9's inbound test adds a pair: `listen_probe.py <port> <secs>` binds one TCP and one UDP
socket on `0.0.0.0:<port>`, logs the source of every connection and datagram, answers each with a
fixed string and exits after `<secs>`; it was run as `ssh <old-vm> 'python3 - 47391 90' <
listen_probe.py`. `send_probe.py <host> <port>` makes one TCP connect (4 s timeout) and sends three
UDP datagrams (2 s each), printing any answer.
