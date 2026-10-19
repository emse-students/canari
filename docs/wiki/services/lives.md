# Lives - the server half (WP-L2, WP-L3, WP-L4)

The server half of the live chantier planned on [live](../frontend/modules/live.md): the `lives` row
and its key (WP-L2), the segment ingest, the manifest viewers poll and the deletion at the end
(WP-L3), the segments served from Canari's nginx cache and the host's viewer cap (WP-L4, built
2026-10-19). WP-L2 and WP-L3 were built 2026-10-18 on the plan's RECOMMENDATIONS, which the user said to take ("take the
decisions"): architecture **C** (segmented HTTP, no transcoding), key design **Q4**, durable end
**Q5**, retention **Q10**. **No client calls any of it yet** (WP-L5), and **it is switched OFF on
production** (below).

Code: `apps/social-service/src/lives/` (row, key, manifest, ingest, sweep, `live-seats.ts`), migration
`091_lives.sql`, `apps/media-service/src/media/live-segments.service.ts` (the bytes), and the
`live_segments` cache in `infrastructure/local/Dockerfile.frontend` (Canari's nginx).

## The switch: `LIVE_ENABLED`

Every `/api/lives` route and the two media routes that serve or store segments answer **404 unless
`LIVE_ENABLED` is exactly `true`** - the nginx segment location included, since what it caches is
media-service's answer (a 404, kept 10 s) (`live-enabled.guard.ts`, `isLiveEnabled` in media-service).
`render-env.sh` computes it per estate (`compute_live_enabled`): **`true` on dev, `false` on
production**, asserted on the rendered files by `deploy-env.test.sh`. The local compose defaults it
to `true`. Three things run whatever it says, on purpose: the live sweep and the media purge and live-list routes, so
a live started while the switch was on is still ended and deleted after it is turned off.

## The numbers, and where each is the ONE copy

| Number | Value | Lives in | Clients read it from |
| --- | --- | --- | --- |
| Largest segment | 4 MiB of ciphertext | `LIVE_SEGMENT_MAX_BYTES`, `lives/live.constants.ts` (and the store's own refusal in media-service) | `GET /api/lives/limits` |
| Reconnect window (Q5) | 60 s without a segment ends the live | `LIVE_RECONNECT_WINDOW_MS`, same file | same route |
| Longest live (L4) | 60 min | `LIVE_MAX_DURATION_MS`, same file | same route |
| Manifest window | 10 segments | `LIVE_MANIFEST_WINDOW`, same file | same route |
| Byte budget per live | 1 687 500 000 B = 2.5 Mb/s (`LIVE_PLANNING_BITRATE_BPS`) x 60 min x 1.5 (`LIVE_BYTE_BUDGET_MARGIN`: encoder overshoot, container, AEAD tag) | `LIVE_BYTE_BUDGET`, same file | same route (`byteBudget`) |
| Segment rate | segment `index` accepted only while `index < 15 + floor(age / 1 s)` | `LIVE_SEGMENT_BURST`, `LIVE_SEGMENT_MIN_DURATION_MS` | same route |
| Starts per account | 6 in a rolling hour; ONE open at a time (the partial unique index) | `LIVE_STARTS_PER_HOUR`, `LIVE_START_WINDOW_MS` | same route (`startsPerHour`) |
| Ingests storing at once, per instance | 4 (the database pool is 10) | `LIVE_INGEST_MAX_CONCURRENT` | - |
| Store timeout / reservation age | 30 s / 35 s | `LIVE_STORE_TIMEOUT_MS`, `LIVE_RESERVATION_TTL_MS` | - |
| Viewer cap of the HOST, all lives together | 24 = floor(90 Mb/s `LIVE_HOST_EGRESS_BPS` x 0.8 `LIVE_EGRESS_SHARE` / 3 Mb/s `LIVE_VIEWER_BITRATE_BPS`) | `LIVE_VIEWER_CAP`, same file | same route (`viewerCap`) |
| Seat lease | 30 s after the last key read or manifest poll | `LIVE_SEAT_LEASE_MS` | same route (`seatLeaseMs`) |

The 60 s window, the bitrate, the margin and the one-second segment floor are planning figures,
**to be confirmed on the WP-L1 bench**.

## The API contract (`/api/lives`, signed-in members, social-service)

Refusals are typed: the body's `code` is the discriminator, never the message.

| Route | Who | Answers |
| --- | --- | --- |
| `GET /api/lives/limits` | any member | the numbers above |
| `GET /api/lives` | any member | the open lives the caller may watch, newest first, at most 50, **no key** |
| `POST /api/lives` `{ key, associationId? }` | any member (L1) | `201` the live with its key. `400 LIVE_KEY_INVALID` (not 64 lower-case hex), `400 LIVE_ASSOCIATION_INVALID`, `403 LIVE_MUTED`, `403 LIVE_ASSOCIATION_FORBIDDEN` (no `POST_AS_ASSO` there), `409 LIVE_ALREADY_OPEN`, `429 LIVE_START_RATE` (6 starts in the hour) |
| `GET /api/lives/:id` | a member who may watch | `{ id, broadcasterId, associationId, startedAt, lastSegmentAt, nextIndex, key }`, `no-store`. Takes a SEAT ([below](#the-viewer-cap-wp-l4)): `503 LIVE_FULL` (with `viewerCap`) past the cap, `503 LIVE_SEATS_UNAVAILABLE` when the seat count does not answer |
| `GET /api/lives/:id/manifest?from=<index>` | same | `{ liveId, nextIndex, lastSegmentAt, serverNow, segments: [{ index, name, bytes }] }` - the newest 10, or from `from` on; `no-store` (the live edge: the shortest cache is none, and the answer is per viewer); renews the seat, same two 503s |
| `DELETE /api/lives/:id/seat` | any member | `204`: the caller's seat on that live goes back to the cap now. Idempotent, no watch check (a viewer may always give back what it holds); `503 LIVE_SEATS_UNAVAILABLE` |
| `PUT /api/lives/:id/segments/:index` raw `application/octet-stream` | the broadcaster | `{ index, name, nextIndex }`. `409 LIVE_SEGMENT_OUT_OF_ORDER` (with `nextIndex`), `409 LIVE_SEGMENT_CONFLICT` (a stored index sent with other bytes), `409 LIVE_SEGMENT_IN_PROGRESS` (that index is still storing: retry, the repeat then answers), `409 LIVE_SEGMENT_RESERVATION_LOST` (its reservation was taken over as abandoned), `413` over 4 MiB, `413 LIVE_BUDGET_EXHAUSTED`, `429 LIVE_SEGMENT_TOO_FAST`, `429` from nginx (no `code`), `400 LIVE_SEGMENT_EMPTY`, `503 LIVE_STORE_UNAVAILABLE` (nothing recorded, the index released), `503 LIVE_INGEST_BUSY` |
| `POST /api/lives/:id/end` | the broadcaster | `{ id, endedAt, endReason }`, idempotent while the row exists; once the end's purge deleted it, a repeat is `404 LIVE_NOT_FOUND`, which the client reads as "ended and deleted" - nothing keeps a deleted live's end to answer with (no replay, L3) |
| `POST /api/lives/:id/removed-viewers` `{ viewerId }` | the broadcaster | `{ liveId, viewerId }`, idempotent; `400 LIVE_VIEWER_IS_SELF` |

**Who may watch** (the key and the manifest, the same rule): absent, or a block between the viewer
and the broadcaster in either direction, is `404 LIVE_NOT_FOUND` (invisible, as the feed hides a
blocked author); an ended live is `410 LIVE_ENDED` to everybody, the broadcaster included; a viewer
the broadcaster removed is `403 LIVE_VIEWER_REMOVED`. A write on another member's live is
`403 LIVE_NOT_BROADCASTER`.

**A segment is read WITHOUT A TOKEN**, `GET /api/media/public/live/<liveId>/<name>`, by the `name`
the manifest gives, and it is answered by Canari's own nginx from the second viewer on (below).

## Serving a segment from the nginx cache (WP-L4)

Built 2026-10-19. **The plan's C9 model**: a segment is ciphertext under the live key, readable by
anyone holding the URL and decryptable only by a holder of the key from the row; the URL is two
uuids, the second chosen at random by the server at ingest and learned only from the manifest. So
what protects a live is the KEY and the MANIFEST, both served by social-service under the watch
rule - not the segment fetch. That is what lets the fetch be the SAME request for every viewer, and
a same request is one a cache answers.

| Where | What it does |
| --- | --- |
| media-service `GET /media/public/live/:liveId/:name` | streams the object `live/<liveId>/<name>` from Garage; no token, `LIVE_ENABLED` checked, no Cache-Control of its own. **Answers the CANONICAL path only** (`LiveSegmentsService.isCanonicalSegmentPath`: both uuids lower case, the raw path exactly `/api/media/public/live/<liveId>/<name>`, no trailing slash, no query, no percent-encoding) and 404s anything else before the store is asked - Express 5 matches any case and a trailing slash, and `/api/media/PUBLIC/live/...` reaches the route through the authenticated `/api/media` location. Replaces the JWT route `GET /media/live/...` of WP-L3, which no client ever called |
| nginx `proxy_cache_path ... keys_zone=live_segments` | http level: 512 MB, `inactive=2m`, written in place (`use_temp_path=off`) |
| nginx `location ^~ /api/media/public/live/` | **owns the whole prefix**: `^~` stops the regex search, so nothing under it can fall into `/api/media/public/` (no cache, no limit) or the `~* \.mjs$` location. Inside, ONE nested regex `"^/api/media/public/live/<uuid>/<uuid>$"` (lower case) is the cached location below; everything else under the prefix is a JSON `404` from the guard itself, before any upstream |

**The rules of that location, each one a line whose loss turns the cache off silently**
(`.github/scripts/tests/live-segments-route.test.mjs` asserts every one):

- `proxy_buffering on` IN the location - it is off server-wide, and nginx never caches an
  unbuffered response.
- `proxy_cache_key $uri` and `proxy_pass http://$upstream_media_live$uri`: a query string is neither
  in the key nor forwarded, so `?x=<random>` cannot bust the cache of an unauthenticated route.
- `proxy_cache_lock on` (10 s): viewers arriving together wait for the FIRST fetch instead of each
  reaching media-service.
- The cookie, `Authorization`, `Origin`, `Range` and `If-Range` are cleared, and the four trust
  headers reset: the upstream request is the same for every viewer. A range is answered by nginx
  from the cached whole (`206`).
- `proxy_cache_valid 200 2m` / `404 10s`: a segment outlives the purge of its live in this cache for at
  most two minutes; a miss (absent, or the switch off) costs one upstream call per 10 s per URL.
- Upstream `Cache-Control`, `Expires`, `Set-Cookie`, `Vary` are ignored for the cache and hidden from
  the client; the ONE policy the client sees is **`private, max-age=120`**: **`private` so no shared
  cache between here and the viewer (the host proxy, a CDN on a legacy name) keeps a segment**, and
  two minutes - this cache's own bound - so the viewer's HTTP cache does not keep the ciphertext of a
  live for an hour after it ended (register C16, C19). A player reads a segment once, inside the
  manifest window, so nothing longer is needed. Until the review of #2105 it was `max-age=3600,
  immutable`: `immutable` is true of the bytes, but it told the device to keep them.
- CORS as nginx's own API errors: the three WebView origins (`$api_error_cors_origin`),
  credentials allowed, `Vary: Origin`; the web app is same-origin. The CSP and the two security
  headers are restated (`add_header` replaces the inherited set). The app's CSP already allows it:
  `connect-src 'self'` on the web, none on Tauri (`"csp": null`).
- `limit_except GET` (HEAD included), and `lives_segments`: 30 r/s burst 60 per client address,
  answering the JSON `@api_error_429`. 30 r/s is the whole cap below fetching a segment a second
  from ONE campus address.
- **The BYTES per address, because `limit_req` counts requests** (30 r/s of 4 MiB segments is ~1 Gb/s
  from one address): `limit_conn lives_segments_conn 12` and `limit_rate 750000` (bytes/s, so 6 Mb/s
  per fetch, twice a viewer's 3 Mb/s: a 3 s segment arrives in 1.5 s and a player can catch up). A
  seated viewer then has a fetch in flight half the time, so the whole cap of 24 behind ONE campus
  address averages 12 at once; **12 x 6 Mb/s = 72 Mb/s, exactly the live share of the uplink
  (`LIVE_HOST_EGRESS_BPS` x `LIVE_EGRESS_SHARE`)** - one address can take the whole live budget, never
  the link. The 13th concurrent fetch is a JSON 429. `live-segments-route.test.mjs` recomputes
  `limit_conn` x `limit_rate` <= cap x viewer bitrate, and `limit_rate` >= 2 x the bitrate, from
  `live.constants.ts`. nginx grants each response one second of head start, so a single short fetch
  runs a little above the rate (3 MB in ~3 s instead of 4); a long one converges on it.
- `X-Canari-Cache: HIT|MISS` on every answer, and the access log shows `urt=- ust=-` on a hit.

**Read on a running container, 2026-10-19** (the image built from this Dockerfile, a stub nginx
standing in for media-service on a Docker network): a 1 MiB segment fetched three times with a
different `?bust=` each time - `MISS`, `HIT`, `HIT`, and ONE request in the upstream's log, without
its query; 20 concurrent fetches of a fresh 3 MB segment - 20 x `200`, ONE upstream request; a range
`206` from the cache; an absent name twice - one upstream request; an upper-case name and a
`/live/x` - 404 without the cache; `POST` - 403; a foreign `Origin` - no `Access-Control-Allow-Origin`;
the stub's `Set-Cookie`, `Cache-Control: no-store` and its own CORS header never reached the client.
**Not read: against the real media-service and Garage, through the host proxy, on a phone.**

**Re-read after the review of #2105, 2026-10-19, same rig** (the final image, a 3 MB stub segment):
the canonical path `200` `MISS` then `HIT`, `Cache-Control: private, max-age=120`; `?x=1` and
`//` (normalised) `HIT`; an upper-case live id, an upper-case name, a trailing slash, `/<name>/x`,
`/live/x` and `/live/` - a JSON `404` from the `^~` guard, none of them in the upstream's log;
`POST` `403`; 30 parallel fetches from one address - 12 x `200` at ~750 000 B/s each, 18 x the JSON
`429`; **ONE upstream request for all of it.** Before the fix the same spellings reached
`/api/media/public/`, and the test's location simulator reproduces that on the old config (every
probe answered by `location /api/media/public/` or `~* \.mjs$`).

**The gate RUNS nginx's location selection, it does not grep for the fix.**
`live-segments-route.test.mjs` parses the `server` block into its location tree and applies
`ngx_http_core_find_location`'s order (exact, longest prefix, `^~` stops the regexes, nested
locations before the level's regexes, regexes in file order) to a set of spellings: the canonical
path must land in the cached location, every other one under the prefix in the `^~` guard.

**What the cache saves, and what it does not.** It saves media-service, Garage and the database
(which the segment route never touched anyway): one store read per segment per two minutes, whatever
the audience. **It does not save a byte of the uplink** - nginx still sends one copy per viewer,
which is what the cap below is for.

## The viewer cap (WP-L4)

L8 asked for no cap; the plan's answer was "a cap set by the host's uplink, to be MEASURED". The
measurement exists ([realtime-media-feasibility](../infrastructure/realtime-media-feasibility.md)
section 4 and 2a: ~90-107 Mb/s out of production on 443, two separate hours, one outside client),
and so does the per-viewer cost ([bench readings](../device-readings-calls-live-2026-10-18.md): the
Chrome/Android encoder averages 2.89-3.06 Mb/s against a 2.5 Mb/s target, Safari 1.45). So:

```
cap = floor(LIVE_HOST_EGRESS_BPS x LIVE_EGRESS_SHARE / LIVE_VIEWER_BITRATE_BPS)
    = floor(90 Mb/s x 0.8 / 3 Mb/s) = 24 viewers, across EVERY live at once
```

The floor of the measured range, a fifth left to everything else on the link (production's own
traffic, dev, Le Cercle, the co-tenant sites), and the heavier of the two encoders. All three are
constants in `live.constants.ts`, served by `/limits`; **the figure to replace first is the egress,
by the DSI's answer (Q3) or a campus-side measurement** - campus viewers may not cross the border at
all, and nobody has measured that path.

**How a seat works** (`lives/live-seats.ts`):

- ONE Redis sorted set per estate, `live:seats`; a member is `<liveId>:<viewerId>`, its score the
  Redis clock of its last renewal. One set for all lives, because they share one link.
- The key read (`GET /:id`) TAKES a seat and every manifest poll RENEWS it, in ONE Lua script: sweep
  the seats older than the lease, then grant if the viewer already holds one or the count is under
  the cap. The check and the write cannot interleave across instances (a rolling deploy runs two),
  and the clock is Redis's own (`TIME`), so no instance's clock is compared with another's. Proven
  against a real Redis: 40 simultaneous takes at a cap of 5 grant exactly 5
  (`live-seats.spec.ts`, gated on `SOCIAL_IT_REDIS_URL`).
- The seat is taken AFTER the watch rule, so a blocked, removed or ended answer is never masked as
  "full"; the broadcaster takes none.
- **Given back by a proof first**: `DELETE /api/lives/:id/seat` when the viewer leaves, the
  broadcaster's removal of a viewer frees that viewer's seat at once, and **an ended live frees all
  of its seats** (`releaseLive`, one Lua script over the set, called by `purgeEnded` - which every
  path that ends a live goes through: the broadcaster's end, the sweep, an ingest that met the end).
  The member's live id is LOWER-CASED (`seatMember`): the take is keyed by the row's id, while a
  leave or a removal carries the id as the URL spelled it, which `ParseUUIDPipe` accepts in upper
  case - and a release naming another member would free nothing.
- **A seat is per ACCOUNT, not per device - a choice.** The request carries no device id, and an
  account is what a removal or a block names. So one device leaving (`DELETE .../seat`) frees the
  seat of an account watching on two; the other device takes it again at its next manifest poll, or
  is told `LIVE_FULL` if somebody took it meanwhile. Two devices of one account cost two copies of
  the uplink for one seat, which the cap does not count. **The 30 s lease is only the
  bound on a viewer that could not say it left** (a crash, a lost network). If it were wrong too
  short, a watching viewer would lose its seat - so it is ten polls long; too long, a departed
  viewer would hold a seat that long, which costs a refusal and never a byte. The set itself expires
  with the lease once nobody renews it.

**The refusal is typed, never prose** - the client's "live complet" screen reads the code:

| Answer | Means | The client shows |
| --- | --- | --- |
| `503 { code: 'LIVE_FULL', viewerCap }` | every seat is held | "live complet", and may retry later; `viewerCap` is the number to name |
| `503 { code: 'LIVE_SEATS_UNAVAILABLE' }` | Redis did not answer (an `error` line) | a failure to retry - **never** "complet": Redis down refuses rather than seats everybody, because an uncounted audience is the overrun the cap prevents |

**THE CAP HOLDS FOR AN HONEST CLIENT ONLY.** A seat is taken by the key read and the manifest poll;
the segment fetch is unauthenticated and checks no seat (that is what lets nginx cache it). So a
client that kept a live's key and polls nothing can go on fetching segment names it already learned,
and a second account can share a manifest with a client that has no seat. **What protects the
CONTENT is the key and the manifest**, both behind the watch rule; **what protects the UPLINK from a
dishonest client is nginx's per-address bound above** (12 fetches x 6 Mb/s), not the seat count.

**For the client (WP-L5), three things this server half decides:**

- **Fetch a segment with a plain `fetch` and no custom header.** The location allows `GET`/`HEAD`
  only, so a CORS PREFLIGHT (`OPTIONS`, which any custom header or a non-simple content type
  triggers from a WebView origin) is answered `403` and the fetch fails as a CORS error. A
  credentialed fetch is allowed (the three WebView origins, `Allow-Credentials: true`) but not
  needed.
- **`LIVE_FULL` is a `503`**, and a 503 is what intermediaries and HTTP stacks may retry on their
  own. The client must read the CODE, show "live complet", and back off - never treat the status
  alone as a transient failure to hammer.
- **A Redis outage stops playback for EVERY viewer**: the key read and every manifest poll answer
  `503 LIVE_SEATS_UNAVAILABLE` within a second (social-service's Redis `commandTimeout`), so open lives freeze
  until Redis answers. That is the deliberate fail-closed cost of the cap (an uncounted audience is
  the overrun it prevents), not a defect to route around.

**The connection budget, and why nothing is raised.** The host proxy is the DSI's: about 1 500
concurrent connections across EVERY site on the host (`worker_connections 768`, two per proxied
connection; [realtime-media-feasibility](../infrastructure/realtime-media-feasibility.md) section 5),
and raising it is their file and their decision. A seated viewer holds at most four: its app
connection (HTTP/2, the API calls ride it too), its WebSocket and that socket's upstream leg (both
held by every signed-in member already), and one segment fetch in flight (short: the host buffers it).
**24 x 4 = 96, under a fifteenth of the budget** - the cap is set by bandwidth long before
connections. Our own nginx keeps the image default (`worker_connections` is not set in
`Dockerfile.frontend`), and the edge's 4 096 is untouched, as are its `pid /var/run/nginx.pid` and
`listen 80`, which its healthcheck reads (#2099). `live-segments-route.test.mjs` fails if the cap
times four ever passes a quarter of 1 500.

**WAF.** The host runs CrowdSec inside its nginx. Up to 24 viewers behind one campus address
polling a manifest and fetching a segment every few seconds is ~10-20 requests a second from that
address, which a crawl scenario could read as abuse. **Unknown, and a question for the DSI before
the first public live** (not a change: a question).

## The key (Q4): served like a post CEK, removal enforced by the server

The key is 32 random bytes **generated by the broadcaster's client** (the client generates every
content key) and sent at `POST /api/lives` as 64 hex characters; the server checks its shape and
stores it in the row. Every member who may watch reads it. It protects the segments against the
store, a cache and anybody without an account - **not against a viewer the broadcaster removed, who
already read it**. Rotation is deliberately NOT the mechanism (the plan's Q4): the server refuses a
removed account the key, the manifest and the listing, and **segment names are random uuids chosen
by the server at ingest**, so the address of the next segment is learned only from the manifest a
removed viewer is refused. What a removed viewer can still do is keep the segments it already
fetched, and fetch an older one whose name it already had.

## The end is the row's state (Q5)

`endedAt` and `endReason` are written ONCE, together (a CHECK ties them), by whichever comes first:

| `endReason` | Written by |
| --- | --- |
| `broadcaster` | `POST /api/lives/:id/end` |
| `dropped` | the sweep, when `COALESCE(lastSegmentAt, startedAt)` is 60 s old |
| `max_duration` | the sweep, or the ingest that finds the hour up (it writes the end and answers 410) |
| `erased` | the account erasure (below) |

`lastSegmentAt` is written by the ingest ONLY - the broadcaster's own liveness, which is the column
the drop predicate reads. "Reconnecting" on a viewer's screen is the client's to show from
`lastSegmentAt` and `serverNow` (both the database's clock); the END is never a client timer.

**Every write takes the live's row lock, and none holds it across the network.** Until the review
of 2026-10-18 the ingest held `SELECT ... FOR UPDATE` - a pooled connection - while it posted up to
4 MiB to media-service, up to the 30 s timeout: ten broadcasters on a slow Garage would have parked
every connection of the pool (10) and stalled every other route of social-service. The ingest is now
THREE steps:

1. **Reserve** - one short transaction: every check under the row lock (owner, end, hour, order,
   repeat, rate, budget), then `pendingName` / `pendingSha256` / `pendingAt` written and COMMITTED.
2. **Store** - no transaction open, no connection held.
3. **Confirm** - one short transaction: under the row lock, insert the segment, advance `nextIndex`,
   add to `storedBytes`, clear the reservation. A failed store CLEARS it instead (the index is free at
   once).

**The lock-order argument, restated for the reservation:**

- *Only the next index, gapless*: the reservation is of `nextIndex` and nothing else; only the
  confirm that holds `pendingName` advances it, and a second ingest of a reserved index is
  `409 LIVE_SEGMENT_IN_PROGRESS` while the reservation is younger than `LIVE_RESERVATION_TTL_MS`.
- *Same bytes idempotent*: unchanged - a repeat of an index below `nextIndex` is answered from
  `live_segments`' `sha256`.
- *An end against an ingest in progress*: an end (the route, the sweep's `UPDATE`) takes the row lock
  only for its own statement, so it waits at most for a reserve or a confirm, never for a store. The
  confirm that follows an end records NOTHING (410) and clears the reservation; the drop predicate
  still reads `lastSegmentAt`, written only by a confirm, so a live that just took a segment is never
  ended by a sweep that started before it.
- *No orphan*: the purge reads the row first and is `kept` while a reservation younger than the TTL is
  set - before it touches the store - and no reservation can be taken once the end has committed (the
  reserve checks `endedAt` under the lock). So when the purge proceeds, the only store of this live
  that can still land is one past its own 30 s timeout; the confirm that met the end purges at once.
- *A reservation whose ingest died* (a crash between reserve and confirm): older than the TTL (the
  store timeout + 5 s, so the HTTP call cannot still be waiting in this process), it is taken over by
  the next ingest with a `warn`, and ignored by the purge.

On top of it, **at most 4 ingests store at once per instance** (`503 LIVE_INGEST_BUSY` beyond, a
`warn`): no connection is held across a store any more, but each holds up to 4 MiB and a
media-service request. Proven on a real PostgreSQL by `lives.integration.spec.ts`: a stalled store on
a pool of ONE connection does not block another query on it; a failed store leaves nothing pending;
an end during a stalled store answers at once, the ingest then gets 410, and nothing outlives the
purge; a purge waits for a live reservation and ignores an abandoned one.

## What one broadcaster may store

Decided 2026-10-18 on review (nothing limited it before). Four bounds, each a typed refusal:

- **A byte budget per live**, `storedBytes` on the row against `LIVE_BYTE_BUDGET` (table above). A
  segment that would cross it is REFUSED (`413 LIVE_BUDGET_EXHAUSTED`) and the live is NOT ended by
  it: nothing more is accepted, so it ends by its broadcaster or, with no segment for 60 s, by the
  sweep - one end path, not a second one for a case only an abusive client reaches.
- **A segment rate held as a COUNT in durable state**: `nextIndex` is the number of segments taken,
  compared with the live's age read from the database clock (`index < 15 + floor(age / 1 s)`), so
  one segment a second on average, whatever retries do, with a burst that covers a reconnect's
  backlog. `429 LIVE_SEGMENT_TOO_FAST`. The specs move `startedAt` by SQL; no wall clock is asserted.
- **Lives per account**: one OPEN at a time (the partial unique index, `409 LIVE_ALREADY_OPEN`), and
  6 STARTED in a rolling hour (`429 LIVE_START_RATE`), counted in `live_starts` because a live's own
  row is deleted at its end. The sweep deletes the rows older than the hour.
- **At the edge**: nginx's `lives_ingest` zone, 2 r/s burst 20 per client address on `PUT` only, and
  `client_max_body_size 5m` ([nginx](../infrastructure/nginx.md)).

## Deletion: at the end, plus a sweep (Q10, L3)

There is no replay. At the broadcaster's end the segments and the row are deleted at once; every
other end, and any purge that failed, is finished by `LiveRetentionScheduler` (every 30 s):

1. end every open live past the reconnect window or the hour;
2. for every ended live: media-service deletes everything under `live/<liveId>/` and **lists the
   prefix again**; social-service deletes the row (segments and removed viewers cascade) **only when
   that listing is empty and no delete failed** - termination from a proof, not from a call that
   returned. A refusal keeps the row, invisible (410), for the next run; a `try` per live. A live
   with a segment still storing is kept too (above), and an OPEN live is never purged by this path;
3. **the orphan reaper**: media-service lists the `live/` folders (`POST /media/internal/live-list`,
   a delimiter listing, one entry per folder) and every folder with NO live row behind it is purged
   and proven empty the same way. A ROW-STATE RULE, NOT A CLOCK: a folder is written only under a
   reservation, which needs the row, and a row is deleted only once its prefix proved empty with no
   reservation in flight - so a folder with no row was written after its purge, by a store that
   outlived its own timeout. The listing is read BEFORE the rows, so a live started in between is not
   in it. Reported as `orphans=` on the `[LIVE_GC]` line, each one a `warn`;
4. the `live_starts` rows older than the hour are deleted.

Observed by `[LIVE]` / `[LIVE_GC]` lines, and the storage panel's `liveSegmentCount` /
`liveSegmentBytes` (media-service `getStorageStats`): segments are outside the media metadata index
by design (a segment every few seconds would rewrite the whole JSON index every few seconds), so the
idle sweep and the account-deletion fan-out never see them, and the panel gives them their own line
instead of `untracked`. **A count that does not fall back to zero between lives is the sweep
stopped.**

## A deleted account

`LIVES_ERASURE_STATEMENTS` (social `account-erasure.ts`): a live the account broadcast is ENDED
(`erased`, unless already ended) and its broadcaster becomes `[deleted]` **in one statement**, so an
open live never carries the tombstone and the one-open-live index never sees two; the sweep deletes
its segments and row within one run. The account's place on another live's removed-viewer list is
deleted, and so are its `live_starts` rows. `broadcaster` and `viewer` were added to the shared account-column pattern
(`libs/contracts/account-reference-columns.json`) so the coverage spec sees both columns. Register
row C19 ([register-of-processing](../compliance/register-of-processing.md)).

## The migration: `091_lives.sql`

Four new tables (`lives`, `live_segments`, `live_removed_viewers`, `live_starts`), nothing existing
changes; idempotent (applied twice by the integration spec), and
`synchronize` against it changes nothing on a live table (asserted). User ids are `varchar(255)`.
No foreign key to `associations`: an association deleted during a live leaves a live that still ends
and is still deleted.

## What is not proven

- **Nothing on a phone, nothing through the HOST proxy, nothing on a real media-service and Garage**:
  the specs are a real PostgreSQL with an in-memory store, a real Redis for the seat script,
  media-service unit specs over a fake bucket, and the HTTP client over a fake transport; the nginx
  cache was read on its own image against a stub upstream (above). The first reading is a dev deploy
  plus a scripted broadcaster and a few viewers, checking `X-Canari-Cache` and media-service's log.
- **The cap's three figures are an outside-client measurement, a bench and a guess**: the egress
  was measured from one workstation (campus viewers unmeasured), the bitrate on Chrome and Safari
  rather than in the app WebViews, and the 0.8 share is a planning choice. **Dev and production count
  their seats apart** (each estate has its own Redis) while sharing the link; dev's audience is the
  testers, so it is accepted, not solved. A seat is per ACCOUNT per live: two devices of one account
  on one live cost two copies and one seat (the choice, above). **The cap is advisory against a
  client that does not poll** (above): the per-address nginx bound is what holds then.
- **Whether CrowdSec on the host reads a campus audience as a crawl** (above): a DSI question.
- **A store that outlives its own timeout** is no longer left behind: while the live lasts it is
  under the live's prefix and the end's purge takes it; one that lands after the purge is a folder
  with no row, which the next sweep's reaper takes. What is not proven is the reaper against a real
  Garage listing (the delimiter listing is exercised on a fake bucket).
- **The ingest semaphore is per instance.** social-service runs one replica (two for a moment during
  a rolling deploy); a second permanent replica would double the bound.
- The 60 s window, the 4 MiB bound, the 30 s seat lease, the 2.5 Mb/s budget and its 1.5 margin, and the one-second
  segment floor are planning figures until WP-L1 measures segment sizes and reconnect times.

## See also

- [live](../frontend/modules/live.md) - the plan, the decisions, the work packages
- [reels](reels.md) - the server model this copies (state is the row, blobs then row, a `try` per item)
- [media-streaming-upload](media-streaming-upload.md) - the 8 MiB body invariant the segment bound sits under
- [account-erasure](../account-erasure.md)
