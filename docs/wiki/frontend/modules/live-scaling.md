# Live scaling - no visible audience ceiling (design, 2026-10-21)

> **The owner's standing wish (2026-10-21): NO VISIBLE AUDIENCE CEILING.** A viewer must never meet
> a "live is full" screen as a product feature; the technique follows the wish, not the other way
> round. This page is the decision-grade design for that: what really bounds the audience today,
> with the arithmetic, the five ways to remove the visible cap, and the staged path with the
> measurement each stage owes. **Nothing here is built and no switch moves.**

**How this page relates to the others.** [live](live.md#uncapped-audience---the-plan-2026-10-20)
holds the 2026-10-20 plan (an edge cache in front of segments, the manifest split, the abuse limits);
[live-production](live-production.md#6-the-viewer-cap---from-24-to-none-in-measured-steps) holds the
cap ladder S0-S6 and the production gates; [lives](../../services/lives.md#the-viewer-cap-wp-l4) holds
the cap as built. **This page changes two things in them**: Cloudflare's terms are now READ (below),
which moves the delivery recommendation from a plain cache rule to an R2 bucket; and the owner's
wish turns "open production at 24 with a `live complet` screen" (D-4 there) into a decision to take
again ([O-3](#7-the-decisions-owed-by-the-owner)).

**Convention: a claim not read in this repository's code, measured, or read at a cited URL on
2026-10-21 is marked _(unverified)_.**

## 1. What bounds the audience today - every candidate, with its number

Read against `main` at `734ddf632` (2026-10-21). One table, one row per candidate the owner named,
then the arithmetic.

| # | Candidate | What the repo says | Binds at | Live-specific? |
| --- | --- | --- | --- | --- |
| B1 | **The host's uplink** | ~90-107 Mb/s out on 443, one outside client, two separate hours ([realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md#4-network-capacity) 4, 9 row 2a); 80 % of it given to lives (`LIVE_EGRESS_SHARE`); campus viewers unmeasured | **~23-31 viewers, all lives together** (arithmetic A) | yes - one copy per viewer |
| B2 | **The host proxy's connections** | a host-wide proxy connection budget set by the school IT department and shared by every site on the host ([realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md#5-nginx-as-the-segment-server-for-live-option-c) 5); 4 per seated viewer | Canari keeps its share under a quarter of it; `live-segments-route.test.mjs` holds the cap there: **93** | mostly no (arithmetic B) |
| B3 | **Our nginx, per client address** | `limit_conn lives_segments_conn 24` (= the cap) and `limit_req` 30 r/s burst 60 on the segment location (`Dockerfile.frontend`) | **24 segment fetches in flight behind ONE address** - a lecture hall behind the campus NAT | yes |
| B4 | **Our nginx, per process** | `worker_connections` not set: the `nginx:stable-alpine` default _(1 024, unverified for this image tag)_ | not near 24 | no |
| B5 | **media-service and Garage fan-out** | the `live_segments` cache with `proxy_cache_lock`: ONE upstream read per segment per 2 min, whatever the audience ([lives](../../services/lives.md#serving-a-segment-from-the-nginx-cache-wp-l4), read on a running container) | **does not bind on audience** - ~0.5 reads/s per live. It binds on the NUMBER OF LIVES through the cache size (arithmetic C) | per live, not per viewer |
| B6 | **Redis seats** | `live:seats`, ONE sorted set for the estate; one Lua script per key read and per manifest poll (`live-seats.ts`): `ZREMRANGEBYSCORE` + `ZSCORE` + `ZCARD` + `ZADD`, O(log S) | not at 24. **With #2202 (open) the script also walks the WHOLE set (`ZRANGE 0 -1`) to count one live's viewers: O(S) per poll, O(N^2) per second** - fine at 24, the first thing to change past it (arithmetic D) | yes |
| B7 | **The per-viewer manifest poll** | 1 poll/s per viewer (`LIVE_MANIFEST_POLL_MS`, client), each: one `auth_request` to core-service (an HS256 verify), then in social-service up to **7 PostgreSQL queries** (`assertMayWatch`: the live with its visibility SQL, the block, the removal; the segment window; with the chat cursors: the viewer's blocks, the messages, the reaction bursts) and **1 Redis script**; pool of 10 connections, of which ingest may use 4 | **unmeasured**: invisible at 24, the wall at a few hundred (arithmetic E) | yes |
| B8 | **The broadcaster's encode and upload** | the phone encodes and seals; the server transcodes nothing (C3). 3.08 Mb/s from the Mi 9T app WebView at a 2.5 Mb/s ask, the Android encoder floored at ~2.6 Mb/s even at 480p; 2.32 Mb/s from iPhone Safari (WP-L1, draft #2109); 4 stores at once per social-service instance (`LIVE_INGEST_MAX_CONCURRENT`) | **never on audience** - a viewer costs the broadcaster nothing. It bounds the number of simultaneous LIVES and the live's own length (battery: ~40 %/h on a charger) | per live |

### The arithmetic

**A - the uplink (B1).** The code: `floor(LIVE_HOST_EGRESS_BPS x LIVE_EGRESS_SHARE / LIVE_VIEWER_BITRATE_BPS)
= floor(90 x 0.8 / 3.0) = floor(72 / 3.0) = 24`. Against what the encoders produce:

| Per-viewer bitrate | Source | 72 Mb/s / bitrate |
| --- | --- | --- |
| 3.08 Mb/s | Mi 9T app WebView, 2.5 Mb/s ask (WP-L1) | 23.4 |
| 3.0 Mb/s | `LIVE_VIEWER_BITRATE_BPS` (the code) | **24** |
| 2.6 Mb/s | the Android floor at a lower ask (480p, WP-L1) | 27.7 |
| 2.32 Mb/s | iPhone Safari, 2.5 Mb/s ask (WP-L1) | 31.0 |
| 107 x 0.8 = 85.6 Mb/s at 3.0 | the upper measured ceiling | 28.5 |

One viewer-hour is 3.08 Mb/s x 3 600 s = 11 088 Mb = **1.39 GB out of the host**. A live of 100 viewers
would need 308 Mb/s, **4.3 times the share** - no tuning of the cap, the bitrate or nginx reaches that
on this link. **B1 is THE bound, and the only one that removing the visible cap cannot survive without
moving the bytes off the host.**

**B - the connections (B2).** A seated viewer holds up to four host-proxy connections: its app
connection (HTTP/2), its WebSocket and that socket's upstream leg, one segment fetch in flight
([lives](../../services/lives.md#the-viewer-cap-wp-l4)). **Three of the four are held by every
signed-in member whether or not they watch** (the app connection and the WebSocket pair), so a
live adds at most ONE connection per viewer - the in-flight segment or manifest request. The 4 x 24
= 96 of the test is therefore an upper bound that double-counts the online audience. With segments
off the host, a live's own increment is the manifest poll's short request: B2 becomes the budget of
**members online at once**, a question for the host whatever lives do.

**C - the cache size (B5).** A segment stays on our nginx's disk until 2 min after its last fetch
(`inactive=2m`), and it is fetched for about the 20 s of the manifest window (10 segments x 2 s), so
a live occupies ~140 s of its bytes: 3.0 Mb/s x 140 s = 420 Mb = **52.5 MB a live**. `max_size=512m`
holds **~9-10 lives** at once; past that the oldest segments go first and cost a refetch from Garage,
never an error. (The Dockerfile comment said "~20 lives" - corrected by this pull request; nothing
else moved.)

**D - the seat script (B6).** Today: O(log S) per call, N calls a second. With #2202's count: each
call reads the whole set, S members, so N viewers polling once a second cost N x S = N^2 member reads
a second inside Redis's single thread: 576 at 24, 10 000 at 100, **250 000 at 500**. The release of an
ended live (`RELEASE_LIVE_SEATS_LUA`) already walks the whole set, once per end. Both stop growing
with one sorted set PER LIVE (`ZCARD` is O(1), the end is a `DEL`) - follow-up F1 below, owned by
whoever lands after #2202, since #2202 owns `live-seats.ts`.

**E - the manifest (B7).** At 1 poll/s: N requests a second, each up to 7 queries:

| Viewers | Polls/s | PostgreSQL queries/s | Mean time per query the 10-connection pool allows (all 10, nothing else running) |
| --- | --- | --- | --- |
| 24 | 24 | 168 | 60 ms |
| 100 | 100 | 700 | 14 ms |
| 500 | 500 | 3 500 | **2.9 ms** |
| 1 000 | 1 000 | 7 000 | 1.4 ms |

The visibility SQL is the post rule (spaces, associations, grants), not a key lookup, and every other
route of social-service shares the pool. **None of this is measured**; it says where to measure
(stage 0), and why the manifest has to stop costing a full watch check per poll before the audience
reaches the hundreds, whatever carries the segments.

**What follows.** In order of what binds first as the audience grows: **B1 (~24) -> B3 (24 behind one
address) -> B7 (hundreds, unmeasured) -> B2 (members online)**. B4, B5, B6 (today) and B8 do not
bind on audience.

## 2. The five options to remove a VISIBLE cap

Each with what it needs, what it risks, the end-to-end encryption, the cost, and moderation. The
invariant every option keeps: **a segment is ciphertext under the live key; its URL is two uuids,
the second random and learned only from the manifest; the KEY (`GET /api/lives/:id`) and the
MANIFEST stay per-viewer, authenticated, behind the watch rule, served by social-service on the
host** ([lives](../../services/lives.md#the-key-q4-served-like-a-post-cek-removal-enforced-by-the-server)).
Caching ciphertext anywhere is therefore harmless to the content; what an option can break is the
key's or the manifest's per-viewer gate, and none of the five touches it.

### (a) Segments from Cloudflare, not from the host

**Cloudflare's terms, READ 2026-10-21** ([Service-Specific Terms](https://www.cloudflare.com/service-specific-terms-application-services/),
"Content Delivery Network", the page dated 2026-09-28): unless an Enterprise customer, *"Cloudflare
offers specific Paid Services (e.g., the Developer Platform, Images, and Stream) that you must use in
order to serve video ... and other large files via the CDN"*, and Cloudflare may limit CDN use *"to
serve video or a disproportionate percentage of pictures, audio files, or other large files"*
without them. **So the plan of [live](live.md#the-delivery-sealed-segments-from-a-cloudflare-cache) -
a Cache Rule on a `canari-emse.fr` name in front of the host - is the use the terms restrict**, and
an action would fall on the whole zone: dev, the legacy redirects, the admin names and our SSH path
all live on it ([cloudflare-edge](../../infrastructure/cloudflare-edge.md)). **Two shapes, then:**

| | (a1) Cache Rule in front of the host | (a2) **R2 bucket on a `canari-emse.fr` custom domain** |
| --- | --- | --- |
| Terms | the restricted case, read above | R2 is part of the Developer Platform the terms name; **whether a free-tier R2 bucket counts as the "Paid Service" the clause asks for is _(unverified)_ - one written question to Cloudflare** |
| Where viewers fetch | the edge; a MISS crosses the tunnel (~19 Mb/s, [realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md#9-probes-of-2026-10-16-servers) 2b) or, with a CNAME to the host's own name, the host directly - which needs a `server_name` in the host's nginx (the school IT department's file) or a Host-header override _(plan-dependent, unverified)_ | R2 directly (public bucket on a custom domain on our zone); **the host is never on the viewer's path** |
| Host egress per live | one copy per segment per edge location filling it (tiered caching _unverified_ on our plan) | **exactly one copy, the upload to R2: ~3 Mb/s a live, whatever the audience** |
| What it needs | the cache rule, `Cache-Control: public` on a 200 only, no `Vary: Origin`, `segmentBase` in the manifest | media-service writes the `live/` prefix to an R2 bucket instead of Garage (both speak S3: an endpoint, a bucket and two secrets, `MIGRATION.md`); the purge and the orphan reaper list and delete THERE (the same proof: list empty after delete); object `Cache-Control: private, max-age=120` (today's bound); the bucket's CORS for the web origin and the three WebView origins; `segmentBase` per estate in the manifest; the web CSP `connect-src` gains that host (Tauri has none) |
| Cost | none per GB _(unverified)_ | ([R2 pricing](https://developers.cloudflare.com/r2/pricing/), read 2026-10-21) egress free; a live-hour of 2 s segments is 1 800 writes (Class A, $4.50/M: **$0.008**, 1 M free a month = 555 live-hours) and N x 1 800 reads (Class B, $0.36/M: **$0.065 per 100-viewer live-hour**, 10 M free a month = 55 such live-hours); storage ~1.4 GB for the hour of a live then deleted, a few thousandths of a GB-month. Whether reads served from Cloudflare's cache in front of a custom domain are billed as Class B is not on the page _(unverified)_ |
| Risks | the terms; the tunnel's 22h-band drops ([cloudflare-edge](../../infrastructure/cloudflare-edge.md#the-tunnel-drops-in-the-22h-band-and-nothing-on-this-page-can-fix-it)) stop every live at once | **a new processor** that sees each viewer's IP address, the live's id (it is in the object path) and the timing - the register (C19) and the privacy policy section 4 change with it ([live-production](live-production.md#5-the-privacy-policy-and-the-terms---written-2026-10-29-owed-the-owners-reread) already says so); whether the host reaches R2's S3 endpoint over 443 _(unverified - it reaches `rtc.live.cloudflare.com`)_; an R2 outage stops segments for every live (a stated failure mode, no second path); whether a public bucket refuses LISTING _(unverified - the names are the capability, a listable bucket would hand them out)_ |

**E2E.** Unchanged in both: R2 or the edge holds ciphertext only, the key never leaves social-service
except to an authenticated viewer. **Moderation.** A removed viewer is refused the key, the manifest
and its seat at once (unchanged), so it learns no new segment name. It can re-fetch the segments whose
names it already had - today from our nginx until 2 min after their last fetch, under (a2) from R2
until the live's purge deletes them, plus at most the `max-age` of a cached copy. **It already holds
the key** (Q4: removal is enforced by refusal, not by rotation), so nothing it can fetch was not
already sent to it. A CUT live: the purge deletes the objects; a copy cached at the edge lasts at most
its `max-age` (120 s). A purge by URL exists as a cleanup, never as the control.

### (b) A lower bitrate ladder per viewer, adaptive

Twitch-style tiers need a second encoding, and the server transcodes nothing (C3, *"il faut que la
charge serveur soit minimale"*). The only source of a second tier is **the broadcaster's phone
running two recorders** (720p and e.g. 360p), each sealed and listed in the manifest, each viewer
choosing by its own throughput.

- **Needs**: two concurrent `MediaRecorder`s on one camera track _(unverified on the Mi 9T's hardware
  encoder and on WKWebView)_; a manifest with tiers; the player's tier switch at a segment boundary
  (every segment already carries its init, [live](live.md#every-segment-is-self-contained)).
- **Risks**: the broadcaster's upload and battery grow by the second tier; storage doubles (there is no byte budget since 2026-10-31); **the Android encoder floored at ~2.6 Mb/s even at 480p** (WP-L1), so
  the low tier may not be low on Android at all - 360p and lower are unmeasured.
- **Capacity**: on the host link, at best 72 / 0.8 = 90 viewers if every viewer took a 0.8 Mb/s tier
  _(a hypothetical tier)_ - a factor of ~3, not "no ceiling". **With (a2) it is a viewer-network
  quality feature, not a capacity one.**
- **E2E / moderation**: unchanged (both tiers sealed under the same key, both names in the
  per-viewer manifest).

### (c) Seats become a counter, and quality steps down instead of refusing

The seat set stops refusing and only COUNTS (it is already the viewer count of #2202). Where a
budget must still be protected, the live's ONE tier steps down for everyone instead of a viewer being
turned away: the server tells the broadcaster a target in the answer to its segment `PUT`, and the
broadcaster starts a new recorder at the next segment boundary - the path a return from the
background already takes ([live](live.md#background-a-lens-taken-and-the-same-live)), and the viewer
already re-appends a changed init.

- **Needs**: F1 (one seat set per live) before the count is per poll at any size; a `targetBps` field
  in the ingest answer; the broadcaster's restart on a change; **D2 reversed** (today the bitrate is
  fixed at launch), [O-5](#7-the-decisions-owed-by-the-owner).
- **Risks**: the restart gap of a new recorder is unmeasured (LIVE-B1 row 8); the Android floor
  (above) may make the step down an illusion; **the marginal viewer degrades every viewer**. And it
  RAISES the ceiling rather than removing it: on the host link, 72 / 1.0 = 72 viewers at 1 Mb/s, 144 at
  0.5 Mb/s _(both tiers hypothetical)_.
- **E2E**: unchanged. **Moderation**: the count must never become a list (#2202's rule); a removed
  viewer's seat is freed at once, as today. **Redis down**: with a cap, the seat take fails closed
  (`503 LIVE_SEATS_UNAVAILABLE`, every viewer stops); with a counter, failing closed stops playback to
  protect nothing - [O-4](#7-the-decisions-owed-by-the-owner).
- **Where it fits**: **as the bound on the number of simultaneous LIVES once segments leave the host**
  - under (a2) each live still costs the host one upload copy (72 / 3.08 = ~23 lives at once), which
  is exactly D2's "pick the tier from the total live load", made continuous. Not as the audience
  answer.

### (d) Relay or peer assist

Viewers fetch segments from each other over WebRTC data channels, the server's copy only for what no
peer has (the peer-assisted CDN pattern). Nothing in the repository does this.

- **Needs**: signalling (the call-service relay or the WebSocket), a swarm per live gated by the
  watch rule, a STUN/TURN path, and a scheduler in the player.
- **Risks**: peers learn each other's IP addresses (the same trade as `iceTransportPolicy: 'all'`
  for calls, [realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md#82-the-four-paths-compared)
  8.2 A); viewers' mobile upload and battery spent for others; relayed pairs cost TURN, which defeats
  the point; a phone in the background stops serving; **school Wi-Fi often isolates clients from each
  other** _(unverified on the campus network)_, which removes the one case it would shine in (a hall
  behind one NAT).
- **E2E**: peers relay ciphertext they can already open (same key). **Moderation**: a removed viewer
  must be evicted from the swarm AND its open channels closed by every peer - a second enforcement
  point the server does not control, where today there is one.
- **Verdict**: research, not a path. The most code, the least control, and (a2) solves the same
  problem without a viewer paying for it.

### (e) A hard refusal only as the last-resort guard, framed as degraded quality

Something finite remains on every path: the manifest (B7), the admission spike of a follower push,
and (before (a2)) the uplink. A guard there is legitimate; a `live complet` screen is not.

- **The shape**: never `LIVE_FULL`. A guard answers `429` with a jittered `retryAfterMs` (the chat
  limits' shape), and the client shows **"Connexion au direct..."** and retries by itself, or - when
  the live has stepped down under (c) - a quiet **"Direct très suivi : qualité réduite"** badge. Both
  are new Paraglide strings, and neither names a number.
- **What it guards, in order**: the admission RATE per live (the push is a thundering herd -
  [live](live.md#abuse-limits-that-are-not-a-viewer-cap)), the per-account poll floor, the per-account
  key-read rate, and a host-egress ALARM (an alarm, never a gate: a person decides).
- **Honesty**: before (a2) a guard on the uplink is a ceiling with a softer face. It must be said to
  the owner as that ([O-3](#7-the-decisions-owed-by-the-owner)), and a viewer who retries for minutes
  has met the ceiling whatever the text says.

## 3. The recommendation

**(a2) for the bytes, F1-F3 for the manifest, (e) for what remains, (c) for the number of lives.**
(a1) is refused by the terms as read; (b) and (d) are not capacity answers on this design.

| Stage | What changes | Measured on | Measured how | Moves on when |
| --- | --- | --- | --- | --- |
| **0 - measure, no code** | nothing | LOCAL estate (a load test on the shared host is not ours to run unasked), then dev | (i) a headless VIEWER load script - **owed: the WP-L1 rig (`tools/live-bench`, draft #2109) injects a broadcaster and collects, it has no viewer swarm**; with it, 24 / 100 / 300 viewers polling the dev-shaped stack: polls/s, social-service CPU, pool wait, Redis scripts/s, p95 manifest latency (B7, B6). (ii) WP-L1 again from the APP WebViews at 360p and at 1.0 / 0.6 Mb/s asks (does the Android floor hold?) - feeds (c). (iii) the written question to Cloudflare on R2-served video | the B7 curve is on this page |
| **1 - the manifest stops costing a full check per poll** | F1, F2, F3 below; helps at 24 too; no infrastructure | local, then dev | stage 0 (i) again, before / after | polls cost one indexed read + one O(1) Redis op |
| **2 - segments to R2 on dev** | (a2) on dev only: the bucket, `segmentBase`, CORS, CSP, the purge against R2; register C19 and the privacy text drafted (HELD, as the lives text was until [live-production](live-production.md#5-the-privacy-policy-and-the-terms---written-2026-10-29-owed-the-owners-reread) 5) | dev, behind its real edge | `X-Canari-Cache` gone from the viewer path; the host's interface bytes during a live (`/proc/net/dev`, read-only) ~3 Mb/s per live whatever N; R2's operation counts per live-hour against the table above; glass-to-glass with the WP-L1 collector (does R2 add to the 5.8-7.3 s?); the purge's empty listing in R2 after an end and after a cut | host egress independent of N, latency unchanged within a second |
| **3 - the visible cap goes** | seats -> counter (F1 done), `LIVE_FULL` and its screen retired, the guards of (e) in place, `limit_conn` per address deleted (segments no longer reach our nginx), Redis-down behaviour per O-4 | dev, then the first announced production live | the admission spike of a real follower push (stage 0's script firing N joins in a second); 429 rates; no `LIVE_FULL` in any log | the owner's yes on O-1..O-4 |
| **4 - the number of lives** | (c) as D2 continued: the tier of each live from the total upload load | dev | WP-L1's restart gap on both phones (LIVE-B1 row 8) | only if lives at once approach ~23 |

**Five lines:**

1. The visible cap exists only because every viewer's copy leaves the school host's ~90 Mb/s uplink (24 x 3 Mb/s); nothing else binds below the hundreds.
2. Move the segments to an R2 bucket on our own `canari-emse.fr` zone: the host uploads one copy per live, viewers fetch ciphertext from Cloudflare, the key and the manifest stay per-viewer on the host.
3. Before or alongside it, make the manifest poll cheap (per-live seat set, the watch rule checked once per seat lease, a server-told poll interval) - the next wall at a few hundred viewers.
4. Then retire `LIVE_FULL`: seats only count, and what still needs a guard answers "Connexion au direct..." with an automatic retry, never "complet".
5. Quality step-down (c) bounds the number of simultaneous lives, not the audience; tiers (b) and peer assist (d) are not on the path.

## 4. The follow-ups this design writes and does not build

| # | What | Where | Why not here |
| --- | --- | --- | --- |
| F1 | **One seat sorted set PER LIVE** (`live:seats:<liveId>`): the count is `ZCARD` (O(1)), the end is `DEL`, the lease sweep is per live. If a host-wide cap must survive until stage 3, a second small key holds the host total | `live-seats.ts` | **#2202 owns that file** (its count walks the shared set, O(S) per poll; it says so itself) |
| F2 | **The gate on a lease**: a poll whose seat is still held skips the watch rule's three queries; a poll without one runs it in full. **Removal stays immediate** because a removal already frees the seat at once ([lives](../../services/lives.md#the-viewer-cap-wp-l4)), so the removed viewer's next poll finds none and is refused; a block or a space change takes effect within one lease (30 s) instead of one poll - [O-6](#7-the-decisions-owed-by-the-owner) | `lives.service.ts` `manifest` | the manifest is #2202's territory too; the removal ordering (the row committed BEFORE the seat is released) needs its own test |
| F3 | **`pollAfterMs` told by the server** in the manifest (as `retryAfterMs` is told), the client's `LIVE_MANIFEST_POLL_MS` becoming its default; and the tail (segment window, chat, reactions) answered from a per-live one-second snapshot, the blocked-author filter moved to the client ([live](live.md#the-manifest-poll-grows-with-the-audience-too), a decision already listed there) | manifest, `livePlayer.ts`, `liveChat.ts` | the same files as #2202 |
| F4 | `limit_conn lives_segments_conn` per address replaced by a rate measured against the campus NAT - or deleted at stage 3 when segments leave our nginx; `live-segments-route.test.mjs` then asserts the new shape | `Dockerfile.frontend`, the test | behaviour-changing; belongs to stage 3 |

**Built in this pull request: nothing behavioural.** The only code-side change is the cache-size
comment of `Dockerfile.frontend` (arithmetic C). No safe, behaviour-neutral structural prep exists
outside `live-seats.ts` and the manifest: every cut of the per-poll cost (F1-F3) goes through the two
files #2202 is changing.

## 5. What could not be verified

- Whether a **free-tier R2 bucket** is the "Paid Service" Cloudflare's CDN clause asks for, and
  whether cache reads in front of an R2 custom domain are billed as Class B.
- Whether a **public R2 bucket refuses listing** (the segment names are the capability).
- Whether the host reaches **R2's S3 endpoint** over 443, and at what rate (the ~90-107 Mb/s is egress
  to one outside client, not to Cloudflare).
- **Tiered caching** and a **Host-header override** on the zone's plan (only for (a1)).
- The **manifest's real cost** per poll (B7) - no load at more than one or two viewers has run.
- The **campus path**: whether campus viewers cross the border, and whether CrowdSec reads a hall
  behind one address as a crawl (G14 of [live-production](live-production.md#2-the-gates-each-with-its-evidence)).
- **Two recorders** at once on the bench phones, the encoder's floor below 480p, and a new recorder's
  restart gap (for (b) and (c)).
- **Client isolation** on the school Wi-Fi (for (d)).
- The `nginx:stable-alpine` default `worker_connections` (B4).

## 6. Not changed by any option

The seal format, the key route and its per-viewer authentication, the removal row, the block, the
watch rule, the staff cut and the strike ladder, the chat's seal, `LIVE_ENABLED`. **Every option
moves ciphertext and counts; none moves a key.**

## 7. The decisions owed by the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| O-1 | **Cloudflare R2 as the store and the delivery of live segments** - a new processor that sees viewers' IP addresses, the live id and timing (register C19, privacy policy section 4, an EU-located bucket _(availability unverified)_) | **Yes** - it is the only option that removes the uplink bound, and the content stays sealed |
| O-2 | **Ask Cloudflare in writing** whether R2 on a custom domain may serve these segments under the CDN clause, before building stage 2 | **Yes** - an action on the zone would take dev, the legacy names and our SSH path with it |
| O-3 | **Production before stage 2**: (i) open at 24 as [live-production](live-production.md#7-the-decisions-owed-by-the-owner) D-4 planned, with `live complet` replaced by the automatic-retry "Connexion au direct..." of (e) - a ceiling with a softer face; or (ii) no public production live until stage 2 | **(i)**, said plainly as a ceiling that remains until stage 2, because every later stage needs production readings - but it REVERSES the letter of the wish for that period, so it is the owner's call |
| O-4 | **Redis down with no cap**: keep playing (the count is unknown, nothing is overrun once segments are off the host) or stop every viewer as today | **Keep playing after stage 2**, with an `error` line; stop as today before it |
| O-5 | **Reverse D2** (bitrate fixed at launch) to allow the live's single tier to step down mid-live, for the number of lives (stage 4) | **Not now** - only if stage 0 (ii) shows the encoders go lower and the restart gap is short |
| O-6 | **A block or a space change takes effect within one seat lease (30 s)** instead of one poll, for the manifest's cost (F2); a removal stays immediate | **Yes** |
| O-7 | **The blocked-author filter of the chat moves to the client** (a blocked author's sealed lines reach the blocker's device and are dropped there), so the tail can be shared - already listed on [live](live.md#the-manifest-poll-grows-with-the-audience-too) | **Yes**, it is ciphertext the viewer already holds the key to |

## See also

- [live](live.md) - the plan and the 2026-10-20 uncapped-audience design this page revises on delivery
- [live-production](live-production.md) - the gates, the cap ladder S0-S6, the HELD privacy wording
- [lives](../../services/lives.md) - the server as built: the cache, the cap, the seats
- [realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md) - every network figure above
- [cloudflare-edge](../../infrastructure/cloudflare-edge.md) - the zone (a2) would add a bucket to
