# Lives - the server half (WP-L2, WP-L3, WP-L4, WP-L7's push, WP-L8's moderation)

The server half of the live chantier planned on [live](../frontend/modules/live.md): the `lives` row
and its key (WP-L2), the segment ingest, the manifest viewers poll and the deletion at the end
(WP-L3), the segments served from Canari's nginx cache and the host's viewer cap (WP-L4, built
2026-10-19), and the push to the broadcaster's followers when a live goes on air (WP-L7's server
half, [below](#the-push-to-the-followers-wp-l7-server-half), 2026-10-19). The moderation of a live - a report, a staff
cut, the first-live rules - is WP-L8's server half ([below](#moderation-wp-l8-server-half), 2026-10-19). WP-L2 and WP-L3 were built 2026-10-18 on the plan's RECOMMENDATIONS, which the user said to take ("take the
decisions"): architecture **C** (segmented HTTP, no transcoding), key design **Q4**, durable end
**Q5**, retention **Q10**. **No client calls any of it yet** (WP-L5), and **it is switched OFF on
production** (below).

Code: `apps/social-service/src/lives/` (row, key, manifest, ingest, sweep, `live-seats.ts`,
`live-announcer.ts`), migrations `091_lives.sql`, `094_live_announced_at.sql` and `097_live_moderation.sql`,
`apps/media-service/src/media/live-segments.service.ts` (the bytes), and the `live_segments` cache in
`infrastructure/local/Dockerfile.frontend` (Canari's nginx).

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
| First-live rules version (L11) | 1 | `LIVE_RULES_VERSION` | same route (`rulesVersion`), and `GET /api/lives/rules` |
| How long a staff cut is kept | 365 days (a planning figure, owed the user's decision) | `LIVE_CUT_RETENTION_MS` | - |

The 60 s window, the bitrate, the margin and the one-second segment floor are planning figures,
**to be confirmed on the WP-L1 bench**.

## The API contract (`/api/lives`, signed-in members, social-service)

Refusals are typed: the body's `code` is the discriminator, never the message.

| Route | Who | Answers |
| --- | --- | --- |
| `GET /api/lives/limits` | any member | the numbers above |
| `GET /api/lives` | any member | the open lives the caller may watch ([the rule of a post](#who-may-watch-the-rule-of-a-post)), newest first, at most 50, **no key** |
| `GET /api/lives/rules` | any member | `{ version, acceptedVersion, acceptedAt }`: the first-live rules the caller must have accepted, and what they did accept ([moderation](#moderation-wp-l8-server-half)) |
| `POST /api/lives` `{ key, associationId?, acceptedRulesVersion? }` | any member (L1) | `201` the live with its key. `400 LIVE_KEY_INVALID` (not 64 lower-case hex), `400 LIVE_ASSOCIATION_INVALID`, `403 LIVE_MUTED`, `403 LIVE_ASSOCIATION_FORBIDDEN` (no `POST_AS_ASSO` there), `403 LIVE_RULES_NOT_ACCEPTED` (with `rulesVersion`), `409 LIVE_ALREADY_OPEN`, `429 LIVE_START_RATE` (6 starts in the hour) |
| `GET /api/lives/:id` | a member who may watch | `{ id, broadcasterId, associationId, startedAt, lastSegmentAt, nextIndex, key }`, `no-store`. Takes a SEAT ([below](#the-viewer-cap-wp-l4)): `503 LIVE_FULL` (with `viewerCap`) past the cap, `503 LIVE_SEATS_UNAVAILABLE` when the seat count does not answer |
| `GET /api/lives/:id/manifest?from=<index>` | same | `{ liveId, nextIndex, lastSegmentAt, serverNow, segments: [{ index, name, bytes }] }` - the newest 10, or from `from` on; `no-store` (the live edge: the shortest cache is none, and the answer is per viewer); renews the seat, same two 503s |
| `DELETE /api/lives/:id/seat` | any member | `204`: the caller's seat on that live goes back to the cap now. Idempotent, no watch check (a viewer may always give back what it holds); `503 LIVE_SEATS_UNAVAILABLE` |
| `PUT /api/lives/:id/segments/:index` raw `application/octet-stream` | the broadcaster | `{ index, name, nextIndex }`. `409 LIVE_SEGMENT_OUT_OF_ORDER` (with `nextIndex`), `409 LIVE_SEGMENT_CONFLICT` (a stored index sent with other bytes), `409 LIVE_SEGMENT_IN_PROGRESS` (that index is still storing: retry, the repeat then answers), `409 LIVE_SEGMENT_RESERVATION_LOST` (its reservation was taken over as abandoned), `413` over 4 MiB, `413 LIVE_BUDGET_EXHAUSTED`, `429 LIVE_SEGMENT_TOO_FAST`, `429` from nginx (no `code`), `400 LIVE_SEGMENT_EMPTY`, `503 LIVE_STORE_UNAVAILABLE` (nothing recorded, the index released), `503 LIVE_INGEST_BUSY` |
| `POST /api/lives/:id/end` | the broadcaster | `{ id, endedAt, endReason }`, idempotent while the row exists; once the end's purge deleted it, a repeat is `404 LIVE_NOT_FOUND`, which the client reads as "ended and deleted" - nothing keeps a deleted live's end to answer with (no replay, L3) |
| `POST /api/lives/:id/removed-viewers` `{ viewerId }` | the broadcaster | `{ liveId, viewerId }`, idempotent; `400 LIVE_VIEWER_IS_SELF` |
| `POST /api/lives/:id/cut` `{ reason, details? }` | a content moderator (`isContentModerator`) | `{ liveId, broadcasterId, reason, cutAt, endReason, newlyCut, priorCuts }`, idempotent. `403 LIVE_CUT_FORBIDDEN` (asked before the live is read), `400 LIVE_CUT_REASON_INVALID` (`spam`/`harassment`/`inappropriate`/`other`), `400 LIVE_CUT_DETAILS_INVALID` (over 500 characters), `404 LIVE_NOT_FOUND` ([moderation](#moderation-wp-l8-server-half)) |

**Every `410` is `{ code: 'LIVE_ENDED', endedAt, endReason }`** (one constructor, `liveEnded`): `endReason` is `broadcaster`, `dropped`, `max_duration`, `erased` or `cut`, and a screen branches on it, never on a message.

### Who may watch: the rule of a post

**A live respects spaces like a post** (decided by the lead on review, 2026-10-19 - a safe default,
reversible; it narrows L2's "the whole network"). `liveVisibleToUserSql` in
`spaces/reader-spaces.ts` states it ONCE, built from the same fragments as `postVisibleToUserSql`:
the broadcaster; a member's live, a reader sharing at least one space with the broadcaster; a live AS
an association, a reader who sees that association (a member, its rules reaching one of their spaces,
or - on the watch paths only - a nominative read grant). A live has no republication, the one
disjunct of the post rule it lacks. An admin is a reader like any other, as when browsing posts.

It gates the four paths together: `GET /api/lives` (the list), the key and the manifest
(`assertMayWatch`, `liveVisibleToViewerSql`, read grants counted as on every post READ path), and the
push's audience (`liveAudienceSql`, the PLAIN predicate - a named reader is never notified for their
perimeter, as for a post's announcement). Pinned on a real PostgreSQL by `lives.integration.spec.ts`
(a follower with no shared space, a follower sharing one, an association reached by its rules or its
membership, a read grant that watches without a push).

**The answers** (the key and the manifest, the same rule): absent, NOT VISIBLE to the viewer, or a
block between the viewer and the broadcaster in either direction, is `404 LIVE_NOT_FOUND` (invisible,
as the feed hides a post it does not show) - asked BEFORE the end, so an outsider never reads a `410`
that would say a live existed; an ended live is `410 LIVE_ENDED` to everybody else, the broadcaster
included; a viewer the broadcaster removed is `403 LIVE_VIEWER_REMOVED`. **A write on another
member's live** (a segment, the end, a removal) **is `404 LIVE_NOT_FOUND`**, the answer to a live that
does not exist - a `403` there would tell any signed-in account which live ids are real (review,
2026-10-19).

**A segment is read WITHOUT A TOKEN**, `GET /api/media/public/live/<liveId>/<name>`, by the `name`
the manifest gives, and it is answered by Canari's own nginx from the second viewer on (below).

## Serving a segment from the nginx cache (WP-L4)

Built 2026-10-19. **The plan's C9 model**: a segment is ciphertext under the live key, readable by
anyone holding the URL and decryptable only by a holder of the key from the row; the URL is two
uuids, the second chosen at random by the server at ingest and learned only from the manifest. So
what protects a live is the KEY and the MANIFEST, both served by social-service under the watch rule ([the rule of a post](#who-may-watch-the-rule-of-a-post): spaces respected, so an outsider never learns a name) -
not the segment fetch. That is what lets the fetch be the SAME request for every viewer, and
a same request is one a cache answers.

| Where | What it does |
| --- | --- |
| media-service `GET /media/public/live/:liveId/:name` | streams the object `live/<liveId>/<name>` from Garage; no token, `LIVE_ENABLED` checked, no Cache-Control of its own. **Answers the CANONICAL path only** (`LiveSegmentsService.isCanonicalSegmentPath`: both uuids lower case, the raw path exactly `/api/media/public/live/<liveId>/<name>`, no trailing slash, no query, no percent-encoding) and 404s anything else before the store is asked - Express 5 matches any case and a trailing slash, and `/api/media/PUBLIC/live/...` reaches the route through the authenticated `/api/media` location. Replaces the JWT route `GET /media/live/...` of WP-L3, which no client ever called |
| nginx `proxy_cache_path ... keys_zone=live_segments` | http level: 512 MB, `inactive=2m`, written in place (`use_temp_path=off`) |
| nginx `location ^~ /api/media/public/live/` | **owns the whole prefix**: `^~` stops the regex search, so nothing under it can fall into `/api/media/public/` (no cache, no limit) or the `~* \.mjs$` location. Inside, ONE nested regex `"^/api/media/public/live/<uuid>/<uuid>\z"` (lower case, and `\z`, never `$`: see below) is the cached location below; everything else under the prefix is a JSON `404` from the guard itself, before any upstream |

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
  from the cached whole (`206`) **because of `proxy_force_ranges on`**: media-service sends no
  `Accept-Ranges`, and without it nginx answers every `Range` with the whole `200` (the first
  version of this page claimed the `206` without it; the stub it was read against was an nginx, which
  sends `Accept-Ranges` itself). Re-read with a stub sending the real route's headers only
  (`Content-Type`, `Content-Length`): `Range: bytes=0-99` -> `206`, `Content-Range: bytes 0-99/3000000`.
- **The regex ends in `\z`, not `$`** (second review of #2105): PCRE's `$` also matches BEFORE A
  FINAL NEWLINE, and `$uri` is decoded, so `<name>%0A` matched the cached location and
  `proxy_pass ...$uri` wrote a raw LF into the upstream request line. Bun refused it with a 400, which
  nginx does not cache - so every such request reached media-service's socket. With `\z` it is the
  guard's 404. In the Dockerfile's `printf` body it is written `\\z`; the generated
  `/etc/nginx/conf.d/default.conf` was read back from the built image and holds `\z`. `%0D%0A` was
  refused either way; `%00` is nginx's own `400` before any location.
- `proxy_cache_valid 200 2m` / `404 10s` with `inactive=2m`: a cached segment stays on this disk
  **until two minutes after it was last fetched** (`inactive`), and is served for at most two minutes
  after it was cached (`proxy_cache_valid`) - so the ciphertext of an ended live is gone here at most
  two minutes after its last viewer fetched it, never later. A miss (absent, or the switch off) costs
  one upstream call per 10 s per URL.
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
  from one address): `limit_conn lives_segments_conn 24` - THE VIEWER CAP, so a full audience behind
  ONE campus address, each with a fetch in flight, is never refused - and `limit_rate 750000`
  (bytes/s, so 6 Mb/s per fetch, twice a viewer's 3 Mb/s: a 3 s segment arrives in 1.5 s and a player
  can catch up). **THE TRADE-OFF, stated:** both cannot fit the live share of the uplink
  (`LIVE_HOST_EGRESS_BPS` x `LIVE_EGRESS_SHARE` = 72 Mb/s): 24 fetches at 2x need 144 Mb/s, and 24 at
  1x leave a player no room to catch up. Honest viewers are not throttled, so **one address is bounded
  at 24 x 6 Mb/s = 144 Mb/s - twice the live share and above the measured link: a COARSE protection**
  (against ~1 Gb/s unbounded), not the uplink budget, which is the seat cap for an honest client. The
  first version sized `limit_conn` at 12, the AVERAGE in flight (24 viewers x half the time), and a
  full audience behind one address got 429s at every peak (second review: 20 parallel -> 12 x 200).
  `live-segments-route.test.mjs` asserts `limit_conn` = the cap, `limit_rate` >= 2 x the bitrate and
  the product <= twice the share, from `live.constants.ts`. **A refusal logs at `warn`**
  (`limit_conn_log_level`, `limit_req_log_level`): it is the limit doing its job, not an `[error]`.
  nginx grants each response one second of head start, so a single short fetch runs a little above
  the rate (3 MB in ~3 s instead of 4); a long one converges on it.
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

**Re-read after the SECOND review of #2105, 2026-10-19, on the real `nginx/1.30.6` image** (a Bun stub
sending the real route's header set, no `Accept-Ranges`): canonical `200`; `%0A`, `%0A` + `x`,
`%0D%0A` and a trailing `/` - `404`; `%00` - nginx's `400`; `Range: bytes=0-99` - `206` from the
cache; 24 parallel fetches from one address - 24 x `200`; 30 parallel - 24 x `200`, 6 x `429`, each
refusal ONE `[warn]` line and no `[error]`; **one upstream request for everything.**

**The gate RUNS nginx's location selection, it does not grep for the fix.**
`live-segments-route.test.mjs` parses the `server` block into its location tree and applies
`ngx_http_core_find_location`'s order (exact, longest prefix, `^~` stops the regexes, nested
locations before the level's regexes, regexes in file order) to a set of spellings: the canonical
path must land in the cached location, every other one under the prefix in the `^~` guard. The
location regex is matched with PCRE's `$` semantics (end, or before a final newline), so the `%0A`
probes fail on a `$`-anchored location - checked by mutation.

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
dishonest client is nginx's per-address bound above** (24 fetches x 6 Mb/s, coarse), not the seat
count.

**For the client (WP-L5), four things this server half decides:**

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
- **A `429` on a segment fetch is nginx's per-address bound** (more than 24 fetches at once, or past
  30 r/s burst 60, from one address). It is a JSON `{ statusCode: 429 }` with the CORS headers, never
  a transport failure. The client keeps ONE segment fetch in flight per player, retries the same
  segment after a short backoff (it is still in the manifest window), and never fans out parallel
  retries - a burst of retries is exactly what the limit counts.

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
| `cut` | a content moderator, `POST /api/lives/:id/cut` ([moderation](#moderation-wp-l8-server-half)) |

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
4. the `live_starts` rows older than the hour are deleted, and the `live_cuts` rows past
   `LIVE_CUT_RETENTION_MS` (`"cutAt" <= now() - retention`, so `live_cuts_cut_at_idx` serves it),
   reported as `cutsPruned=` on the `[LIVE_GC]` line. Each prune in its own `try`, so a throw in one
   skips neither the other nor the report.

Observed by `[LIVE]` / `[LIVE_GC]` lines, and the storage panel's `liveSegmentCount` /
`liveSegmentBytes` (media-service `getStorageStats`): segments are outside the media metadata index
by design (a segment every few seconds would rewrite the whole JSON index every few seconds), so the
idle sweep and the account-deletion fan-out never see them, and the panel gives them their own line
instead of `untracked`. **A count that does not fall back to zero between lives is the sweep
stopped.**

## Moderation (WP-L8, server half)

Built 2026-10-19 on the user's decisions D3 (any member may broadcast, so moderation is a RELEASE
BLOCKER: no stable carries lives without it) and D6 (moderation works like posts:
[moderation-and-blocking](../moderation-and-blocking.md)). **No client calls any of it yet**: the
report control on the viewer, the cut button in `/admin/moderation`, the rules screen sending
`acceptedRulesVersion` and the "cut" screen are the client follow-up (below).

| Control | Who | Where | What it does |
| --- | --- | --- | --- |
| **Report a live** | any member the live is visible to | `POST /api/moderation/reports` `{ contentType: 'live', contentId: <liveId>, reason }` | a `content_reports` row - the posts' ONE store, same reason list, same once-per-person-per-thing dedup (`409 ALREADY_REPORTED`). `reportedUserId` is the broadcaster READ FROM THE LIVE ROW, never the client's. The live must still have a row (open, or ended and not yet purged) and be visible to the reporter by [the rule of a post](#who-may-watch-the-rule-of-a-post) with no block, else `404 LIVE_NOT_FOUND`: the report route is no oracle for a live the reporter could not watch. No auto-hide: a live is CUT by a person, never by a count. A live already deleted (no replay) cannot be reported: the person can. **No rate limit beyond the dedup**, exactly as posts (none exists on `/api/moderation`) |
| **Read the queue** | content moderators | `GET /api/moderation/reports` | a live report carries `live: { state, broadcasterId, broadcasterName, associationId, startedAt, endedAt, endReason, cutReason, broadcasterCuts }` and `contentPreview` = the broadcaster's name. `state`: `open` (the cut button), `ended` (row not yet purged), `cut`, `gone` (ended and purged: nothing left to watch or cut; mute the person). The live's id is the link: the viewer overlay opens a live by id |
| **Cut** (staff remote cut, the live's "delete the post") | `isContentModerator` - a platform admin or a BDE member holding `MODERATE`, the predicate of the posts' moderation controls | `POST /api/lives/:id/cut` | [below](#the-cut) |
| **Remove a viewer** | the broadcaster | `POST /api/lives/:id/removed-viewers` (since WP-L2) | a durable `live_removed_viewers` row: the key, the manifest and the listing refused (`403 LIVE_VIEWER_REMOVED`), the seat freed at once. The viewer client maps it to its "removed" screen. **Not a Redis set with a TTL**: the row IS the state and goes with the live (cascade), so no clock decides it |
| **Block** | either person | core-service `user_blocks` | the live hidden from the list and refused (`404`) both ways, and the push not sent (since WP-L2/L7) |
| **A muted member cannot broadcast** | - | `POST /api/lives` | `403 LIVE_MUTED`, the posting rule (`user_moderation.isMuted`). There is no ban state other than the mute |
| **First-live rules** (L11) | the broadcaster | `POST /api/lives` `acceptedRulesVersion`, `GET /api/lives/rules` | [below](#the-first-live-rules-l11) |
| **Hide a chat message** | the broadcaster | WP-L6, not built | [the contract below](#hiding-a-chat-message-the-contract-for-wp-l6) |

### The cut

ONE transaction under the live's row lock - the lock every segment, end and removal already takes,
so PostgreSQL orders a cut against them rather than anything reconciling them afterwards:

1. **recorded** in `live_cuts` (migration 097), once per live - a repeat answers the first cut with
   `newlyCut: false`;
2. an OPEN live is **ended** with `endReason = 'cut'`. A live already ended (by its broadcaster, a
   drop, the hour) KEEPS its reason and the cut is still recorded: a broadcaster ending their live as
   the moderator presses does not escape the record, but the cut rewrites nothing - the cut row
   copies the live's end (`liveEndedAt`, `liveEndReason`), so the `410` after the purge is the `410`
   before it - and the broadcaster gets no "stopped by moderators" notice: they ended it themselves;
   **an ERASED broadcaster's live is never cut** (`410 LIVE_ENDED` `endReason: 'erased'`, nothing
   recorded): every erased account shares `DELETED_ACCOUNT`, so a cut recorded under it would pool
   every deleted member into ONE repeat offender;
3. every PENDING report on it is marked `reviewed` by that moderator - the reports' own trail. There
   is no separate moderation audit log in this repository (the posts path has none either), so
   `content_reports.reviewedBy`/`reviewedAt` and `live_cuts.reviewerId`/`cutAt` ARE the trail.

After the commit: the purge (every seat released, segments and row deleted - or left to the sweep
while a segment is storing, whose confirm then purges), and an in-app notice to the broadcaster
(`post_notifications` type `live_cut`, `text` = the reason CODE, no actor; **no push yet**: a push
needs `notif_social_live_cut_*` in both native apps first, so `skipPush` - and so no "no push
content" warn either). The broadcaster's own screen learns it at once from the `410` its next
segment gets.

**Why `live_cuts` outlives the live row.** The row is deleted at the end (L3), within milliseconds of
a cut. The cut row is then what answers `410 LIVE_ENDED` with the live's own end (`endReason:
'cut'` when the cut ended it, at the cut's time):

- to a VIEWER: `assertMayWatch` finds no live row, asks `live_cuts` with the same rule of a post (the
  cut keeps the live's `broadcasterId` and `associationId`, so `liveVisibleToViewerSql` reads it as
  it reads a live) and the same block check - so an outsider still reads `404`, never learning that
  a live existed;
- to the BROADCASTER: its next `PUT` segment and its `POST .../end` (`200 { endReason: 'cut' }`);
- to nobody else: another member's write stays `404`.

**Races, proven on PostgreSQL** (`lives.integration.spec.ts`): a cut during a stalled segment store
answers at once, the purge waits for the reservation, the segment then gets `410 cut` and nothing
outlives the purge; a cut, a segment and a viewer join fired together - whichever ran first, every
refusal is `410 cut` and nothing is served after it. A viewer whose key read began before the cut
committed may take a seat AFTER the purge freed them: that seat lasts at most its 30 s lease (its
next poll is a `410` that renews nothing). The same holds for every kind of end, not only a cut -
filed in [backlog](../backlog.md#p1---live-moderation-wp-l8-the-server-half-is-built-the-client-half-and-four-decisions-are-owed-2026-10-19).

**Repeat offenders: RECORDED, NO POLICY.** No strike or ban mechanism exists for posts (only the
manual mute), so none is invented here: `live_cuts` keeps who, when and why, `priorCuts` (on the
cut's answer) and `broadcasterCuts` (in the queue) show the count, and the mute is the moderator's
manual sanction. **What a count should trigger, and how long a cut is kept (365 days today), are the
user's to decide** ([backlog](../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)).

### The first-live rules (L11)

`live_rules_acceptances`: one row per account, the version accepted and when. A start is refused
`403 LIVE_RULES_NOT_ACCEPTED` `{ rulesVersion }` unless the recorded version is at least
`LIVE_RULES_VERSION`, or the start carries `acceptedRulesVersion` EQUAL to it - which records it
(raised, never lowered), even if the start is then refused for another reason (rate, an open live):
the acceptance happened. Any other value (an older version, a string) is refused: a client showing
older rules has not shown these. Checked AFTER the mute and the association right, so a muted member
records nothing. `GET /api/lives/rules` tells the pre-live screen whether to show them. **Raise
`LIVE_RULES_VERSION` when the rules' TEXT changes**; every member then accepts once more.

**THE CLIENT CONTRACT (for the broadcaster, #2115):** send `acceptedRulesVersion: <rulesVersion>`
in `POST /api/lives` when the member tapped Start on the screen showing the rules; read
`rulesVersion` from `GET /api/lives/limits` (or `version` from `/rules`); on `403
LIVE_RULES_NOT_ACCEPTED`, show the rules again. Until the broadcaster sends it, a dev start by a
member who never accepted is refused.

### Hiding a chat message: the contract for WP-L6

The live chat is not built (WP-L6, another agent). What moderation needs from it, decided now so it
is built in rather than added:

- **Each chat line carries a server-assigned id** (uuid) and its author's account id, outside the
  ciphertext (the line is encrypted with the live key, so the server reads only the envelope).
- **The broadcaster hides a line**: `POST /api/lives/:id/chat/:messageId/hide`, broadcaster only,
  `404 LIVE_NOT_FOUND` for anyone else (the write rule of this API), idempotent. The server records
  the id in a per-live hidden set that goes with the live (a table cascading from `lives`, like
  `live_removed_viewers`), stops relaying the line, and broadcasts `{ type: 'live.chat.hidden', id }`
  so every viewer removes it. A hidden line is never served to a viewer who joins later.
- **A removed viewer cannot post**: the chat send checks `live_removed_viewers` and blocks, as the
  key does.
- **Staff reach**: a cut ends the chat with the live. Reporting ONE chat line (`contentType:
  'live_chat'`) would mean the reporter attaching the decrypted text - the privacy decision that kept
  `message` out of `content_reports` - so it is NOT planned; a viewer reports the live or the person.

### What the client still owes (strings for Paraglide)

- **Viewer**: a `410` with `endReason: 'cut'` gets its own screen instead of "Le live est terminé"
  (`live_viewer_cut_title`: FR "Ce live a été interrompu par la modération", EN "This live was
  stopped by moderators"). `LiveRefusalError` must carry `endReason` from the body (it carries
  `endedAt` today).
- **Viewer report control**: `ReportReasonDialog` with `contentType: 'live'`; `409 ALREADY_REPORTED`
  and `404 LIVE_NOT_FOUND` handled as for a post.
- **Broadcaster**: the uploader's `410` with `endReason: 'cut'` stops the broadcast with
  `live_broadcast_cut_title`: FR "Votre live a été interrompu par la modération", EN "Your live was
  stopped by moderators"; the rules screen sends `acceptedRulesVersion`.
- **Bell**: a `live_cut` row (`NotificationRow`, `KNOWN_NOTIFICATION_TYPES`, no link):
  `notif_live_cut_text`: FR "Votre live a été interrompu par la modération", EN "Your live was
  stopped by moderators", plus the reason from `text` through the existing report-reason labels.
  Until then the row renders as an unknown type (neutral, unlinked).
- **Admin queue**: the `live` content-type label (`moderation_type_live`: FR "Live", EN "Live"), the
  `live.state`, and a "Couper le live" / "Cut the live" button on `open` and `ended` rows calling
  `POST /api/lives/:id/cut` with the reason picker.
- `LiveEndReason` and `LiveRefusalCode` gain `cut`, `LIVE_RULES_NOT_ACCEPTED` and `LIVE_CUT_*`.

## A deleted account

`LIVES_ERASURE_STATEMENTS` (social `account-erasure.ts`): a live the account broadcast is ENDED
(`erased`, unless already ended) and its broadcaster becomes `[deleted]` **in one statement**, so an
open live never carries the tombstone and the one-open-live index never sees two; the sweep deletes
its segments and row within one run. The account's place on another live's removed-viewer list is
deleted, and so are its `live_starts` rows. The cuts OF its lives (`live_cuts`) and its first-live rules
acceptance are deleted; a cut it MADE as a moderator is anonymised (the decision stays). Lock order:
`lives` first, then `live_cuts`, the order a cut takes them. `broadcaster` and `viewer` were added to the shared account-column pattern
(`libs/contracts/account-reference-columns.json`) so the coverage spec sees both columns. Register
rows C19 and C20 ([register-of-processing](../compliance/register-of-processing.md)).

## The push to the followers (WP-L7, server half)

The user's question, 2026-10-19: *can a follower get "X est en live" the way they get "X a publie"?*
Decisions L5 and L10 of the [plan](../frontend/modules/live.md): a push ONLY to the followers of the
member or association broadcasting. Built in `LiveAnnouncer` (`lives/live-announcer.ts`); **the
client half - the LIVE card in the feed and the app route the tap opens - is NOT built** (below).

| Question | Answer, and where it is decided |
| --- | --- |
| **When** | At the **first STORED segment**, not at `POST /api/lives`: a row alone has nothing to watch, and a start the client abandons (camera refused, app killed, an immediate end) would ring every follower for nothing. So a refused start, and a live ended before its first segment, are never announced. |
| **Once per live** | `lives."announcedAt"` (migration 094). Segment 0's CONFIRM stamps it in the SAME transaction, under the same row lock, as the segment itself (`WHERE "announcedAt" IS NULL`), and the push follows the commit. A repeat of segment 0, a reconnect, every later segment: the same stamped row, no second push. A NEW live (a new row) is a new announcement. No timer and no sweep: there is no second path to reconcile. |
| **The trade** | Stamp before send, as `PostAnnounceScheduler` does: a crash between the commit and the send loses ONE announcement (`[LIVE_ANNOUNCE] ... NOT announced` at warn when it is an error rather than a crash); the other order could repeat it. A failing announcement never fails the segment. |
| **Not awaited** | The ingest STARTS the announcement after segment 0's commit and answers without waiting for it, so segment 0 and its ingest slot (`LIVE_INGEST_MAX_CONCURRENT`) never wait on the audience query or the fan-out. Once per live is untouched - the claim is the commit, not the call. `LivesService` tracks the announcements in flight: `announcementsSettled()` resolves when they have (awaited at module shutdown, and by the integration spec before it reads a push - a proof, never a delay); a rejection reaching it would be a defect in `announce`, logged at error. |
| **Who** | A member's live: `user_follows` (followers of the broadcaster). A live AS an association: `association_follows` of that association - the member's own followers are NOT told. Both minus the broadcaster, minus a follower the live is not VISIBLE to ([the rule of a post](#who-may-watch-the-rule-of-a-post): a member's follower with no space in common, an association's follower its rules and membership do not reach), minus either side of a block with the broadcaster and a viewer the broadcaster already removed: exactly who `assertMayWatch` lets in (read grants aside, which never notify), narrowed to followers (`liveAudienceSql`). |
| **The name** | The association's `name`, or the member's display name from `PostNotificationsService.resolveDisplayName`. **A member with no name to give (no `users` row, or no name in it) is NOT announced** - `[LIVE_ANNOUNCE] ... NOT announced: broadcaster ... has no display name` at warn - rather than titled with the 64-hex user id, the fallback `resolveActorName` keeps for its other callers. A lookup that FAILED is a different outcome, classified where it happens: `resolveDisplayName` throws (only `null` means "no name"), and the one warn line carries that cause instead. Either way the claim is committed, so it is not retried. |
| **Mutes** | `association_push_mutes`: `live_started` is in `MUTABLE_PUSH_TYPES`, applied by `PostNotificationsService` like an association's post ([social-service](social-service.md)). A member's live has no association, so no mute applies. |
| **Notification levels** | The push's `contentKey` `social_live_started` is filed under the reader's **`posts`** category in chat-delivery (`push-category.ts`): the switch that silences the posts of the people you follow silences their lives too. No new category (it would need a settings row on the client). |
| **The pipeline** | `PostNotificationsService.pushNotice`: the same content mapping, icon rule (the association's logo, the member's face), mute and bounded per-recipient fan-out as `createNotifications`, sharing one private `fanOutPush`, but **no `post_notifications` row** - a live is deleted at its end (L3), so a bell row would be a 404 for ever after. |
| **Language** | Composed ON THE DEVICE from `contentKey`, as every social push since 2026-08-19: `notif_social_live_started_*` (Android, fr + en) and `notif.social.live_started.*` (iOS app and NSE, fr + en) - FR "X est en live" / "Appuyez pour regarder", EN "X is live" / "Tap to watch". The server's French `title`/`body` ride along for builds older than the key. Pinned by `push-content.spec.ts` and `nativeStrings.test.ts`. |
| **Payload** | `{ type: 'social', liveId, associationId?, deepLink: 'fr.emse.canari://live/<liveId>', contentKey, actorName, contentArg: '', iconUserId or iconMediaId }` - `socialDeepLink` writes the link. |
| **The switch** | Nothing is sent unless `LIVE_ENABLED` is `true` (checked by the announcer itself, on top of the ingest route's own guard): **off on production**. |

Observed by `[LIVE_ANNOUNCE] <liveId> by <broadcaster> kind=member or association followers=<n>`.

**The tap, and what the client still owes (WP-L7's other half, with WP-L5):** `appRouteForDeepLink`
(`frontend/src/lib/mobile/deepLinkRoutes.ts`) owns the `live` host and sends it to the FEED
(`/posts`), and `tauri.conf.json` declares it (Android's deep-link plugin drops an undeclared host)
with its intent filter in the committed `AndroidManifest.xml`, as #1635 did for the agenda hosts
(`deepLinkHostsDeclared.test.ts` pins both).
A build older than that change does not route the tap: Android opens the app and stays where it was,
and a link that reaches the hook lands on `/notifications` with the unknown-host warn. Owed: the
`live/<id>` case reading the id once WP-L5's viewer page exists; the LIVE card at
the top of the feed (L5) reading `GET /api/lives`; and the store builds carrying the new native
strings (an installed build without them shows the server's French wording, with a warn).

## The migration: `091_lives.sql`

Four new tables (`lives`, `live_segments`, `live_removed_viewers`, `live_starts`), nothing existing
changes; idempotent (applied twice by the integration spec), and
`synchronize` against it changes nothing on a live table (asserted). User ids are `varchar(255)`.
No foreign key to `associations`: an association deleted during a live leaves a live that still ends
and is still deleted.

`094_live_announced_at.sql` adds `lives."announcedAt"` and, in the same step that creates the column,
stamps every existing row with its start; a re-run touches nothing. Nothing sweeps for unannounced
lives - only segment 0's confirm claims one - so what the backfill changes is narrow: a live caught
MID-START by the deploy (row written, segment 0 not yet confirmed) is never announced. 094 because it
is the next free number on `main` (093 its highest on 2026-10-19).

`097_live_moderation.sql` (WP-L8): `endReason` accepts `cut` (the CHECK dropped and re-added, the
same definition every run), and two new tables, `live_cuts` (no foreign key to `lives`: it outlives
the row on purpose) and `live_rules_acceptances`. Applied twice by the integration spec, and
`synchronize` changes nothing on them (asserted). 097 because `main` ends at 094, #2116 holds 096
and #1940 is renumbering into the space below it (2026-10-19).

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
