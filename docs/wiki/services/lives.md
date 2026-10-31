# Lives - the server half (WP-L2, WP-L3, WP-L4, WP-L6, WP-L7's push, WP-L8's moderation)

The server half of the live chantier planned on [live](../frontend/modules/live.md): the `lives` row
and its key (WP-L2), the segment ingest, the manifest viewers poll and the deletion at the end
(WP-L3), the segments served from Canari's nginx cache and the host's viewer cap (WP-L4, built
2026-10-19), and the push to the broadcaster's followers when a live goes on air (WP-L7's server
half, [below](#the-push-to-the-followers-wp-l7-server-half), 2026-10-19), and the live chat and
floating reactions ([WP-L6](#live-chat-and-floating-reactions-wp-l6), 2026-10-19, draft). The moderation of a live - a report, a staff
cut, the first-live rules - is WP-L8's server half ([below](#moderation-wp-l8-server-half), 2026-10-19), and the strike ladder and the reported chat line are WP-L8b's ([below](#the-strike-ladder-wp-l8b), 2026-10-21). WP-L2 and WP-L3 were built 2026-10-18 on the plan's RECOMMENDATIONS, which the user said to take ("take the
decisions"): architecture **C** (segmented HTTP, no transcoding), key design **Q4**, durable end
**Q5**, retention **Q10**. The client (WP-L5) is built, and **since the production flip of
2026-10-30 the deploy lock is open on both estates**: production serves lives from the stable that
carries it, whenever `platform_config.lives_mode` says `on` (below).

Code: `apps/social-service/src/lives/` (row, key, manifest, ingest, sweep, `live-seats.ts`,
`live-announcer.ts`, `live-chat.service.ts`, `live-chat.controller.ts`, `live-report-age.scheduler.ts`), migrations `091_lives.sql`,
`094_live_announced_at.sql`, `097_live_moderation.sql`, `098_live_chat.sql` and
`099_live_strikes_and_reported_chat_lines.sql`,
`apps/media-service/src/media/live-segments.service.ts` (the bytes), the runtime kill switch
(`lives-mode.ts` in both services, core-service's `015_platform_config_lives_mode.sql`), and the `live_segments` cache in
`infrastructure/local/Dockerfile.frontend` (Canari's nginx).

## The two switches: `LIVE_ENABLED` and `lives_mode`

Every `/api/lives` route and the two media routes that serve or store segments answer **404 unless
BOTH switches are open** - the nginx segment location included, since what it caches is
media-service's answer (a 404, kept 10 s). The answer is the same whichever switch is closed.

**The deploy lock, `LIVE_ENABLED`** (`live-enabled.guard.ts`, `isLiveEnabled` in media-service):
open only when exactly `true`. **The literal `true` on both estates since the production flip
(owner, 2026-10-30)** - a `literal:true` row of `infrastructure/deploy/env-manifest.tsv` that
`render-env.sh` writes into each estate's `.env` and both services read (the compose default stays
`false`, so a render that lost the key fails closed); asserted on the rendered files by
`deploy-env.test.sh`. Until then it was computed per estate, `true` on dev and `false` on production.
The local compose defaults it to `true`. Moving it takes a deploy, which is why the runtime switch
below is what closes lives now.

**Turning lives on in production, as it was done.** One pull request moved both deploy-time locks
(this variable and the client's `LIVE_ENABLED` in `features.ts`) and the camera and microphone
purpose strings; the release that carries it opens the routes the moment it deploys, so **what decides
whether production members see lives is `lives_mode` at that moment** - `on` in production, and
kept on by the owner's decision of 2026-10-30, so lives open discreetly with the `1.5.2` stable. The gates, the readings and
the order are on [live-production](../frontend/modules/live-production.md), the only copy.

**The runtime kill switch, `platform_config.lives_mode`** (owner, 2026-10-21: lives get a switch
the server holds BEFORE they open in production, exactly like calls - once the client lock is in a
store binary, closing lives again would otherwise take a stable store release). `off` / `on`,
core-service migration `015_platform_config_lives_mode.sql`, **default `off` on every row, dev's
included** (the dev seed writes `on`). A global admin moves it at `/admin/platform`
(`PATCH /api/users/admin/platform`, `GlobalAdminGuard`, a `warn` line `livesMode off -> on by=<8
chars>`). Read, never cached, on every request:

- social-service: `LiveEnabledGuard` asks `LIVE_ENABLED` first (a closed estate never reads the
  database), then `readLivesMode` (`lives/lives-mode.ts`, one primary-key read of `auth_db`'s
  one-row table, as chat-delivery reads `calls_mode`). Both live controllers sit behind that guard.
- media-service has no database: each segment route asks social-service's internal
  `GET /api/internal/lives/mode` (`InternalLivesModeController`, `X-Internal-Secret`; `fetchLivesMode`
  in `media/lives-mode.ts`) AFTER its own cheap refusals (the secret, the canonical path), so a
  caller refused anyway never costs the hop. No cache on media-service's side: nginx's
  `live_segments` cache already makes it one hop per segment per cache miss.

**FAIL CLOSED everywhere.** A missing row reads `off` (logged at `error`); a value outside the two
throws (500), as does a failed read; an unreachable or refusing relay is a 503 on media-service. A
switch that cannot be read is never read as open.

**What a flip to `off` does, and its one bound.** From the next request: no live starts, no
manifest, no key, no chat, no ingest - an on-air broadcaster's next segment is a 404 (its own end
route too), and the live is ended by the sweep after 60 s without a segment. **A segment nginx ALREADY cached stays servable for up to its two minutes**
(`proxy_cache_valid 200 2m`) to a caller holding its URL: ciphertext under a key no new viewer can be
handed, learned only from a manifest that now answers 404. A flip to `on` waits out at most the
10 s of a cached refusal on a segment URL fetched while closed. **The staff routes close with it**
(cut, withdrawal, chat hide sit behind the same guard): a live on air at the flip ends through the
60 s sweep, but staff cannot cut it until lives reopen. Intended, as the simplest consistent
behaviour - one guard, nothing live answers while closed, and nothing is left on air to cut - and
open to revisiting if a closed estate ever needs a staff path.

**The client hides what the server would refuse.** `GET /api/version` carries `lives: { mode }`;
the client's `livesAvailable(serverLivesMode())` (`utils/livesAvailability.ts`) is the build's
`LIVE_ENABLED` AND `on`, and gates the live card, the viewer and the composer's Live chip
([live](../frontend/modules/live.md)). Absent or unknown reads `off`.

Three things run whatever either switch says, on purpose: the live sweep and the media purge and
live-list routes, so a live started while the switches were open is still ended and deleted after
they close. What must be true before lives open in production, and in what order:
[live-production](../frontend/modules/live-production.md).

## The numbers, and where each is the ONE copy

| Number | Value | Lives in | Clients read it from |
| --- | --- | --- | --- |
| Largest segment | 4 MiB of ciphertext | `LIVE_SEGMENT_MAX_BYTES`, `lives/live.constants.ts` (and the store's own refusal in media-service) | `GET /api/lives/limits` |
| Reconnect window (Q5) | 60 s without a segment ends the live | `LIVE_RECONNECT_WINDOW_MS`, same file | same route |
| Longest live (L4) | **NONE (owner, 2026-10-31).** A live ends by its broadcaster, by 60 s without a segment, by staff or by an erasure - never by a clock | `maxDurationMs` is still served, as `LIVE_LEGACY_MAX_DURATION_MS` (a safe integer) for builds up to 1.5.x that print it ([legacy-compatibility](../legacy-compatibility.md)); nothing enforces it | same route, ignored by current clients |
| Manifest window | 10 segments | `LIVE_MANIFEST_WINDOW`, same file | same route |
| Stored bytes per live | **No total budget (owner, 2026-10-31); a running live keeps its newest `LIVE_RETAINED_SEGMENTS` = 20 segments only** (trim, [below](#what-one-broadcaster-may-store)): at most 20 x 4 MiB = 80 MiB whatever its duration. `lives."storedBytes"` counts the retained bytes | `LIVE_RETAINED_SEGMENTS`, `LIVE_TRIM_BATCH`, same file | `byteBudget` is no longer served |
| Segment rate | segment `index` accepted only while `index < 15 + floor(age / 1 s)` | `LIVE_SEGMENT_BURST`, `LIVE_SEGMENT_MIN_DURATION_MS` | same route |
| Starts per account | 6 in a rolling hour; ONE open at a time (the partial unique index) | `LIVE_STARTS_PER_HOUR`, `LIVE_START_WINDOW_MS` | same route (`startsPerHour`) |
| Ingests storing at once, per instance | 4 (the database pool is 10) | `LIVE_INGEST_MAX_CONCURRENT` | - |
| Store timeout / reservation age | 30 s / 35 s | `LIVE_STORE_TIMEOUT_MS`, `LIVE_RESERVATION_TTL_MS` | - |
| Viewer cap of the HOST, all lives together (**the user wants NO cap, 2026-10-20; the cap stays until the [plan](../frontend/modules/live.md#uncapped-audience---the-plan-2026-10-20) is measured; no VISIBLE ceiling, 2026-10-21: [live-scaling](../frontend/modules/live-scaling.md)**) | 24 = floor(90 Mb/s `LIVE_HOST_EGRESS_BPS` x 0.8 `LIVE_EGRESS_SHARE` / 3 Mb/s `LIVE_VIEWER_BITRATE_BPS`) | `LIVE_VIEWER_CAP`, same file | same route (`viewerCap`) |
| Seat lease | 30 s after the last key read or manifest poll | `LIVE_SEAT_LEASE_MS` | same route (`seatLeaseMs`) |
| First-live rules version (L11) | **2** (raised 2026-10-21: the sheet shows the posts' publication rules) | `LIVE_RULES_VERSION` | same route (`rulesVersion`), and `GET /api/lives/rules` |
| How long a staff cut is kept, and the strike window | **90 days** (decided 2026-10-20) - the ladder counts the cuts still on record | `LIVE_CUT_RETENTION_MS`, `LIVE_STRIKE_WINDOW_MS` (the same value) | same route (`strikeWindowMs`) |
| A suspension of broadcasting | 30 days from the cut that set it (strike 2 and later) | `LIVE_SUSPENSION_FROM_STRIKE`, `LIVE_SUSPENSION_MS` | same route (`suspensionMs`) |
| A withdrawal may be taken from | 3 cuts on record | `LIVE_WITHDRAWAL_FROM_CUTS` | - |
| Longest a reported chat line is kept | 90 days from `keptAt`, or the report handled, whichever is first | `LIVE_CHAT_REPORT_MAX_KEEP_MS` | - |
| Response commitment to a live report | 24 h of WORKING time (Monday to Friday, `Europe/Paris`) - past it, the [hourly alarm](#the-24-h-alarm-on-the-live-report-queue-wp-l8b-item-e) is an `error` | `LIVE_REPORT_RESPONSE_WORKING_MS`, `LIVE_REPORT_WORKING_ZONE` | - |

**Read against the WP-L1 bench on dev (2026-10-19,
[live](../frontend/modules/live.md#wp-l1---measured-2026-10-19)), every bound held with no change:**
0 refusals in ~2 200 segments (the only `409`s came after an index the bench itself gave up on, during a background test). An Android broadcaster sends 3.1 Mb/s for a 2.5 Mb/s target (0.83 of
the 3.75 Mb/s the budget allows over an hour), an iPhone 2.3 Mb/s; the largest 2 s segment was
1.58 MB (two merged fragments), under the 4 MiB bound (a 4 s segment reached 3.1 MB the same way - one more reason for 2 s); 2 s segments sit well inside the one-per-second
floor, and 1 s segments (1.03 s p50 apart) drew no `429`; a broadcaster that stopped was ended 77 s after
its last segment (the 60 s window plus the sweep).

## The API contract (`/api/lives`, signed-in members, social-service)

Refusals are typed: the body's `code` is the discriminator, never the message.

| Route | Who | Answers |
| --- | --- | --- |
| `GET /api/lives/limits` | any member | the numbers above |
| `GET /api/lives` | any member | the open lives the caller may watch ([the rule of a post](#who-may-watch-the-rule-of-a-post)), newest first, at most 50, **no key** |
| `GET /api/lives/rules` | any member | `{ version, acceptedVersion, acceptedAt }`: the first-live rules the caller must have accepted, and what they did accept ([moderation](#moderation-wp-l8-server-half)) |
| `GET /api/lives/standing` | any member | the CALLER's own `{ cutsOnRecord, suspendedUntil, withdrawnAt }` ([the ladder](#the-strike-ladder-wp-l8b)), so the pre-live screen can say why a start would be refused before it is pressed |
| `POST /api/lives` `{ key, associationId?, acceptedRulesVersion? }` | any member (L1) | `201` the live with its key. `400 LIVE_KEY_INVALID` (not 64 lower-case hex), `400 LIVE_ASSOCIATION_INVALID`, `403 LIVE_MUTED`, `403 LIVE_ASSOCIATION_FORBIDDEN` (no `POST_AS_ASSO` there), `403 LIVE_RULES_NOT_ACCEPTED` (with `rulesVersion`), `403 LIVE_BROADCAST_WITHDRAWN`, `403 LIVE_BROADCAST_SUSPENDED` (with `suspendedUntil`), `409 LIVE_ALREADY_OPEN`, `429 LIVE_START_RATE` (6 starts in the hour), `503 LIVE_KEY_SEALING_UNAVAILABLE` (no secret to seal the key: nothing written, [the key at rest](#the-live-key-at-rest)) |
| `GET /api/lives/:id` | a member who may watch | `{ id, broadcasterId, associationId, startedAt, lastSegmentAt, nextIndex, key }`, `no-store`. Takes a SEAT ([below](#the-viewer-cap-wp-l4)): `503 LIVE_FULL` (with `viewerCap`) past the cap, `503 LIVE_SEATS_UNAVAILABLE` when the seat count does not answer, `503 LIVE_KEY_UNAVAILABLE` when the stored key does not open ([the key at rest](#the-live-key-at-rest)) |
| `GET /api/lives/:id/manifest?from=<index>` | same | `{ liveId, nextIndex, lastSegmentAt, serverNow, segments: [{ index, name, bytes }], viewers }` - the newest 10, or from `from` on; `viewers` is [how many watch](#the-viewer-count-2026-10-21), a number and never a name; `no-store` (the live edge: the shortest cache is none, and the answer is per viewer); renews the seat, same two 503s |
| `DELETE /api/lives/:id/seat` | any member | `204`: the caller's seat on that live goes back to the cap now. Idempotent, no watch check (a viewer may always give back what it holds); `503 LIVE_SEATS_UNAVAILABLE` |
| `PUT /api/lives/:id/segments/:index` raw `application/octet-stream` | the broadcaster | `{ index, name, nextIndex }`. `409 LIVE_SEGMENT_OUT_OF_ORDER` (with `nextIndex`), `409 LIVE_SEGMENT_CONFLICT` (a stored index sent with other bytes), `409 LIVE_SEGMENT_IN_PROGRESS` (that index is still storing: retry, the repeat then answers), `409 LIVE_SEGMENT_RESERVATION_LOST` (its reservation was taken over as abandoned), `413` over 4 MiB, `413 LIVE_BUDGET_EXHAUSTED`, `429 LIVE_SEGMENT_TOO_FAST`, `429` from nginx (no `code`), `400 LIVE_SEGMENT_EMPTY`, `503 LIVE_STORE_UNAVAILABLE` (nothing recorded, the index released), `503 LIVE_INGEST_BUSY` |
| `POST /api/lives/:id/end` | the broadcaster | `{ id, endedAt, endReason }`, idempotent while the row exists; once the end's purge deleted it, a repeat is `404 LIVE_NOT_FOUND`, which the client reads as "ended and deleted" - nothing keeps a deleted live's end to answer with (no replay, L3) |
| `POST /api/lives/:id/removed-viewers` `{ viewerId }` | the broadcaster | `{ liveId, viewerId }`, idempotent; `400 LIVE_VIEWER_IS_SELF` |
| `POST /api/lives/:id/cut` `{ reason, details? }` | a content moderator (`isContentModerator`) | `{ liveId, broadcasterId, reason, cutAt, endReason, newlyCut, priorCuts, strike, consequence, standing }`, idempotent ([the ladder](#the-strike-ladder-wp-l8b)). `403 LIVE_CUT_FORBIDDEN` (asked before the live is read), `400 LIVE_CUT_REASON_INVALID` (`spam`/`harassment`/`inappropriate`/`other`), `400 LIVE_CUT_DETAILS_INVALID` (over 500 characters), `404 LIVE_NOT_FOUND` ([moderation](#moderation-wp-l8-server-half)) |
| `POST /api/lives/broadcasters/:userId/withdrawal` `{ reason, details? }` | a content moderator | `{ userId, reason, withdrawnAt, newlyWithdrawn, cutsOnRecord }`, idempotent. `403 LIVE_WITHDRAWAL_FORBIDDEN` (asked first), `400 LIVE_ACCOUNT_INVALID`, the cut's two `400`s, `409 LIVE_WITHDRAWAL_NOT_DUE` (with `cutsOnRecord`, `required: 3`) |
| `DELETE /api/lives/broadcasters/:userId/withdrawal` | a content moderator | `{ userId, lifted }`, idempotent; `403 LIVE_WITHDRAWAL_FORBIDDEN`, `400 LIVE_ACCOUNT_INVALID` |

**Every `410` is `{ code: 'LIVE_ENDED', endedAt, endReason }`** (one constructor, `liveEnded`): `endReason` is `broadcaster`, `dropped`, `erased` or `cut` (`max_duration` is no longer written: no live has a longest duration, and the database check still allows it for rows of the past), and a screen branches on it, never on a message.

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
  `connect-src 'self'` on the web; on Tauri the WebView's `connect-src` names every backend a
  store build may bake ([cloudflare-edge](../infrastructure/cloudflare-edge.md#no-script-runs-unless-the-policy-names-it-2026-10-22)).
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

**THE OWNER'S STANDING WISH (2026-10-20, restated 2026-10-21): NO VISIBLE AUDIENCE CEILING FOR A
LIVE - "the technique must follow".** The cap of 24 below is a TEMPORARY TECHNICAL BOUND (the host's
uplink, as measured), never a product rule. The "live complet" screen is not a product feature: it
exists only until the cap goes ([the plan](../frontend/modules/live.md#uncapped-audience---the-plan-2026-10-20)),
and nothing may be built on it or around it (no waiting list, no "full" badge, no messaging that
treats a ceiling as intended). Lifting the cap is a separate design.

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
  (`live-seats.spec.ts`, gated on `SOCIAL_IT_REDIS_URL`, run in CI by `test-social-integration`
  since 2026-10-21 - [cicd](../cicd.md)).
- The seat is taken AFTER the watch rule, so a blocked, removed or ended answer is never masked as
  "full"; the broadcaster takes none.
- **Given back by a proof first**: `DELETE /api/lives/:id/seat` when the viewer leaves, the
  broadcaster's removal of a viewer frees that viewer's seat at once, and **a live CUT or ERASED
  frees all of its seats** (`releaseLive`, one Lua script over the set, called by `purgeEnded`). An
  ORDINARY end (broadcaster, silence) keeps them: they are what its purge
  [waits for](#deletion-at-the-end-plus-a-sweep-q10-l3), and each viewer gives its own back on the
  end's `410` (or lets it lapse within the lease - no renewal is possible after the end).
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
| `503 { code: 'LIVE_KEY_UNAVAILABLE' }` | the stored key does not open ([the key at rest](#the-live-key-at-rest), an ERROR line naming the reason) | a failure to retry (`unavailable`), never "complet" and never terminal |
| `503 { code: 'LIVE_KEY_SEALING_UNAVAILABLE' }` | on a START: no secret to seal the key with, nothing written | a failure to retry (`unavailable`) |

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

**The connection budget, and why nothing is raised.** The host proxy is the DSI's: a host-wide
proxy connection budget set by the DSI and shared by EVERY site on the host (two per proxied
connection; [realtime-media-feasibility](../infrastructure/realtime-media-feasibility.md) section 5),
and raising it is their file and their decision. Canari keeps its share under a quarter of it. A seated viewer holds at most four: its app
connection (HTTP/2, the API calls ride it too), its WebSocket and that socket's upstream leg (both
held by every signed-in member already), and one segment fetch in flight (short: the host buffers it).
**24 x 4 = 96, well inside that quarter** - the cap is set by bandwidth long before
connections. Our own nginx keeps the image default (`worker_connections` is not set in
`Dockerfile.frontend`), and the edge's 4 096 is untouched, as are its `pid /var/run/nginx.pid` and
`listen 80`, which its healthcheck reads (#2099). `live-segments-route.test.mjs` fails if the cap
times four ever passes a quarter of the budget.

**WAF.** The host runs CrowdSec inside its nginx. Up to 24 viewers behind one campus address
polling a manifest and fetching a segment every few seconds is ~10-20 requests a second from that
address, which a crawl scenario could read as abuse. **Unknown, and a question for the DSI before
the first public live** (not a change: a question).

## The viewer count (2026-10-21)

**The owner's decision (2026-10-21): the viewers of a live see HOW MANY watch it, like Instagram,
and so does its broadcaster.** The number is EXACT, not rounded - confirmed by the owner
2026-10-21 ([below](#exact-not-rounded---confirmed-by-the-owner-2026-10-21)). Before it, nobody saw a number and the broadcaster had no list
either: no route answers viewer ids (the broadcaster learns an account id only from a chat line's
author, which is how a removal names one). That stays true - **a COUNT, never an identity and never a
list, to anybody: the broadcaster, a viewer, staff.**

**A viewer is a SEAT** - an account holding one on this live (above): taken by the key read, renewed
by every manifest poll, gone on `DELETE .../seat`, a removal, the live's end, or 30 s without a poll.
So the count is accounts, not devices (a seat is the account's), the broadcaster is never counted (it
takes none), and the caller is counted in its own answer. **A blocked account is counted**: a block
between the broadcaster and a member keeps that member from watching (no seat, so not counted), but a
block between two VIEWERS hides neither from the other's count - the same stance as online presence,
which a block does not hide either (register C18, [moderation-and-blocking](../moderation-and-blocking.md#what-a-block-does-not-do)).
A number names nobody, so there is nothing for a block to withhold. **No second tracker and no new state**: the
count is read from `live:seats`, in Redis, by the scripts of `live-seats.ts`:

- **a viewer's poll**: `TAKE_SEAT_LUA` answers `{1, seated, watching}`, `watching` counted in the
  SAME script as the grant, after the sweep - so it never disagrees with the cap, and a lapsed seat is
  gone from it before it is counted;
- **the broadcaster's poll** (its chat loop, `chat=1`, the one request it already makes):
  `COUNT_LIVE_SEATS_LUA`, read-only, the seats renewed within the lease on Redis's clock - exactly
  the ones the next sweep keeps. Its KEY read (`GET /:id`, on a return from the background) shows no
  count and runs none (`viewerCount` is asked by the manifest only).

**The members are read INSIDE the script** and only a number leaves Redis, so no viewer's id reaches
social-service for this, let alone a response. `lives.integration.spec.ts` asserts that neither a
viewer's nor the broadcaster's manifest carries another viewer's id; `live-seats.spec.ts` proves the
count against a real Redis (two lives, a renewal not counted twice, a leave, a lapsed lease, a
refusal carrying no count).

**It rides the poll both sides already make** - the manifest, once a second; no new loop, no new
route, and the cost per viewer is the one script it already ran, now also walking the set. That walk is
linear in the set, which the cap bounds (24 members across every live). **When the cap goes** ([the
plan](../frontend/modules/live.md#uncapped-audience---the-plan-2026-10-20)), a poll walking every
seat of the estate is N x N: the seats move to one set PER LIVE (`ZCARD`), which is that plan's own
"the set only COUNTS" step.

**If the count does not answer.** A viewer's take fails closed as it always did (`503
LIVE_SEATS_UNAVAILABLE`; no count is ever made up). The broadcaster's read is its CHAT poll too, which
a display number must not take down: `watching` answers `null`, logged as an `error` (`[LIVE_SEAT]
... the viewer count did not answer`), and the screen shows no number. Every viewer's poll is failing
on the same outage at that moment, so the line is not alone.

### Exact, not rounded - confirmed by the owner 2026-10-21

**EXACT, CONFIRMED BY THE OWNER 2026-10-21.** The implementer proposed it from the "like Instagram"
reference, and the owner accepted it on being asked. The reasoning, kept so it is not re-opened: the
plan had proposed a rounded count for viewers. With at most 24 seats an exact small number can tell someone who already suspects it that a
particular person just arrived (the count went from 3 to 4 when a friend said "I'm opening it"). Rounding
was weighed and refused: at this size any bucket wide enough to hide one arrival (say 1-5, 6-10)
makes the number useless as "how many are here", and it only moves the tell to the bucket's edge. The
count carries no identity, the chat already shows its writers' names to the same audience, and an
arrival is otherwise invisible. So "like Instagram" was taken literally: the exact number, to the
broadcaster and the viewers alike, with no asymmetry between them.

## The key (Q4): served like a post CEK, removal enforced by the server

The key is 32 random bytes **generated by the broadcaster's client** (the client generates every
content key) and sent at `POST /api/lives` as 64 hex characters; the server checks its shape and
stores it in the row, SEALED ([below](#the-live-key-at-rest)). Every member who may watch reads it. It protects the segments against the
store, a cache and anybody without an account - **not against a viewer the broadcaster removed, who
already read it**. Rotation is deliberately NOT the mechanism (the plan's Q4): the server refuses a
removed account the key, the manifest and the listing, and **segment names are random uuids chosen
by the server at ingest**, so the address of the next segment is learned only from the manifest a
removed viewer is refused. What a removed viewer can still do is keep the segments it already
fetched, and fetch an older one whose name it already had.

### The live key at rest

Decided by the user 2026-10-22, migration 110. Until then `lives."liveKey"` held the key in the
clear, next to the chat ciphertext it opens (`live_chat_messages.sealed`) and the segment names it
opens, so **a database copy or a backup alone could open a live's chat and segments**. The row now
keeps only `"liveKeyCiphertext"` + `"liveKeyVersion"`:

- **The seal** is `common/secret-box.ts` (the one the Lydia Business keys use, migration 100):
  AES-256-GCM, a fresh 96-bit IV per seal, a key derived by HKDF-SHA256 from
  **`LIVE_KEY_ENCRYPTION_SECRET`** (32+ characters; dev: `DEV_LIVE_KEY_ENCRYPTION_SECRET`, each
  estate its own value), and the AAD `live:<liveId>:v<version>` - a ciphertext copied to another
  live's row, or relabelled with another version, does not open. Its OWN secret, not the Lydia one:
  one leaked or rotated secret never reaches the other's rows.
- **ONE reader**, `lives/live-key-at-rest.ts`: `openLiveKey` (and `openLiveKeyOr503`) serves the
  viewer's `GET /api/lives/:id` and the report check of a chat line (`ModerationService`); nothing
  else selects the columns for their value. A failure is a `LiveKeyUnavailableError` with a reason
  CODE (`secret-missing`, `unknown-version`, `does-not-open`, `malformed`, `absent`), logged at ERROR
  where it is thrown, answered `503 LIVE_KEY_UNAVAILABLE` - never a null, and never a report
  `MISMATCH` (the reporter's text was not found false, it could not be checked).
- **The start refuses before writing**: no secret, `503 LIVE_KEY_SEALING_UNAVAILABLE`, no row. The
  id is chosen by the service (not the column default) because the seal is bound to it.
- **The deploy refuses a missing or short secret** (`env-manifest.tsv` `required` on both estates,
  `render-env.sh` 32-character floor), as for the Lydia one.
- **The backfill is the live sweep's step 0** (`LivesService.sealPlaintextKeys`, every 30 s), not
  the migration: the secret is not, and must never be, in the database. One conditional `UPDATE`
  per row writes the ciphertext and NULLs the plaintext together (`WHERE "liveKey" = <the value
  read>`), so an interrupted run leaves every row wholly in one form, and a re-run or two replicas
  seal a row once. It reads a partial index (`lives_plaintext_key_idx`); the steady state is one
  empty query. Until it reaches a row, `openLiveKey` reads the plaintext at WARN - the previous
  format's reader, owed by the durable rule on at-rest envelopes. A row the sweep cannot seal is
  logged at ERROR and counted in `[LIVE_GC] keysUnsealed=`.
- **The CHECKs**: `lives_key_one_form` (exactly one of plaintext / ciphertext), `lives_key_version`
  (a ciphertext always names its version).
- **Rotation**: only `LIVE_KEY_VERSION` (1) opens today. A rotation adds the next version's secret
  beside this one, seals new lives under it, and keeps the old one until the last row of the old
  version is purged - an hour after its live's start at most, plus the purge. Rotating the secret IN
  PLACE makes every open live answer 503 until it ends; do it with no live on air.
- **The overlap deploy and a rollback**: social-service is `canari.deploy.replace: overlap`, so for
  the seconds both releases answer - and after a rollback, until the live ends - the OLD release
  reads only `"liveKey"`. For every live the new sweep has already sealed it serves **`key: null`**
  (unwatchable through it) and answers a chat-line report **`400 LIVE_CHAT_REPORT_MISMATCH`** (the
  line does not open with a null key). The new sweep seals lives ALREADY OPEN too, not only new
  ones, so this reaches a live that was on air before the deploy. Nothing to undo in the schema, and
  a plaintext is never restored. Production met none of it: `LIVE_ENABLED` was false there until the
  flip of 2026-10-30, so no live was open on production for either release to serve.
- **What it does not protect**: social-service still holds the key (C12: the seal protects against
  the store and the database's readers, never against social-service), and a database copy taken
  WITH the environment opens everything. The previous plaintext column is dropped once production
  counts 0 non-null rows ([legacy-compatibility](../legacy-compatibility.md)).

## The end is the row's state (Q5)

`endedAt` and `endReason` are written ONCE, together (a CHECK ties them), by whichever comes first:

| `endReason` | Written by |
| --- | --- |
| `broadcaster` | `POST /api/lives/:id/end` |
| `dropped` | the sweep, when `COALESCE(lastSegmentAt, startedAt)` is 60 s old |
| `max_duration` | NEVER WRITTEN since 2026-10-31 (no duration cap); kept in the database check only |
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

1. **Reserve** - one short transaction: every check under the row lock (owner, end, order,
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

- **NO total byte budget and NO longest duration (owner, 2026-10-31, reversing the 2026-10-18 budget) -
  and a TRIM that makes "nothing is stored" true.** The budget was 2.5 Mb/s x 60 min x 1.5, a duration
  cap in disguise. Before the trim a live stored EVERY sealed segment for its whole length (the manifest
  only LISTED the newest ten): about 1.1 GB an hour at 2.5 Mb/s, all of it until the end's purge. Now a
  running live keeps only its newest `LIVE_RETAINED_SEGMENTS` = 2 x `LIVE_MANIFEST_WINDOW` = 20
  segments, so **what one live stores is at most 20 x 4 MiB (`LIVE_SEGMENT_MAX_BYTES`) = 80 MiB, whatever
  its duration** (about 20-40 MB at the planning bitrate). `storedBytes` is the retained bytes.
  - **Why 20**: a manifest names the newest 10; the other 10 are the margin for a viewer that fetched
    its manifest just before a trim and is still downloading. A viewer polls every second and a
    segment is ~2 s, so ten more segments are ~20 s against the download of ~1 MB; a viewer further
    behind than its buffer policy jumps to the newest (`livePlayer` backlog) instead of walking the
    past, and every segment is self-contained (no init to keep).
  - **Mechanism** (`LivesService.trim`, after each confirmed segment): the segments to trim are the
    `live_segments` rows with `index < nextIndex - 20` (at most `LIVE_TRIM_BATCH` = 50 a pass);
    media-service deletes the named objects (`POST media/internal/live-segments-delete`, idempotent -
    an absent object is not a failure); THEN, in one transaction, the rows are deleted and
    `storedBytes` falls by exactly their bytes. **Idempotence is durable state, not a clock**: a
    crash between the media delete and the row delete, a refused delete or a media outage leave the
    row, which the next segment's pass finds again. Each pass logs `[LIVE_TRIM] ... trimmed n
    segment(s) (a..b), B`; a refusal or an unreachable store is a `warn` and never fails the segment
    just stored. The end's purge is unchanged (it deletes the whole prefix, trimmed or not), so
    correctness never rests on the trim; only the bound does.
  - **Two edges**: a retry of a segment more than 20 behind the newest meets a trimmed row (409
    `LIVE_SEGMENT_CONFLICT`; the uploader only ever retries the last one); a manifest asked `from` an
    index older than the oldest kept row answers from the oldest kept.
  - **Deploy order**: media-service carries the new route; a social-service deployed before it logs
    the trim's `warn` on each segment until media catches up (nothing breaks), then converges.
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

There is no replay. At the broadcaster's end the segments and the row are deleted at once **unless a
viewer still holds a seat**; every other end, and any purge that failed or waited, is finished by
`LiveRetentionScheduler` (every 30 s).

**An ordinary end drains its viewers first (LIVE-WEB-2, 2026-10-29).** The purge of an ended live
is `kept` while the live holds a seat (`LiveSeats.watching(id, 'purge')`, the seats renewed within
the lease). A seat is renewed by every manifest read and by nothing else, so a held seat is a viewer
told of segments within the lease that has not said it left: the segments its last manifest named
are still its to fetch. On `1.5.1-alpha.7` the end's purge deleted segments 5 and 6 between the
manifest that named them and their download - `404` on both viewers, then the manifest's `404`. The
order is now a FACT, not a delay: the viewer's player gives its seat back on the end's `410`
(`livePlayer.ts`), and the next sweep purges; a viewer that never does lets its seat lapse within
`LIVE_SEAT_LEASE_MS` (30 s).

**Whether to drain is read from durable facts by `purgeEnded` itself, never from `endReason`** (a
cut of a live already ended keeps its earlier reason, and the erasure writes
`COALESCE("endReason", 'erased')`):

- **a `live_cuts` row, or a broadcaster that is `DELETED_ACCOUNT`**: moderation or the account's
  deletion removed it, so every seat is released and the segments go at once - a cut just after an
  ordinary end, or an erasure inside its drain, included;
- **`endedAt` older than the lease, on the database clock**: every read answers `410` from `endedAt`
  on (`assertMayWatch`), so no seat can have been renewed since and every one has lapsed; Redis is
  not asked, so its outage never holds media past the lease;
- **otherwise** the seats are read: one held keeps the live (a `debug` line), and a count that cannot
  be read keeps it too (the seat module's `error`, naming the purge) - for at most the lease.

So an ordinary end's segments outlive it by at most the lease plus one sweep, whatever Redis does.
The steps of a sweep:

1. end every open live past the reconnect window;
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
   `LIVE_CUT_RETENTION_MS` (90 days; `"cutAt" <= now() - retention`, so `live_cuts_cut_at_idx` serves
   it), reported as `cutsPruned=` on the `[LIVE_GC]` line; and the [reported chat lines](#a-reported-chat-line-wp-l8b)
   whose report is handled, or whose `keptAt` is 90 days old, reported as `chatLinesErased=` (an
   UNHANDLED line erased by the bound is a `warn`: a report nobody read in 90 days). Each prune in its
   own `try`, so a throw in one skips neither the others nor the report.

Observed by `[LIVE]` / `[LIVE_GC]` lines, and the storage panel's `liveSegmentCount` /
`liveSegmentBytes` (media-service `getStorageStats`): segments are outside the media metadata index
by design (a segment every few seconds would rewrite the whole JSON index every few seconds), so the
idle sweep and the account-deletion fan-out never see them, and the panel gives them their own line
instead of `untracked`. **A count that does not fall back to zero between lives is the sweep
stopped.**

## Moderation (WP-L8, server half)

Built 2026-10-19 on the user's decisions D3 (any member may broadcast, so moderation is a RELEASE
BLOCKER: no stable carries lives without it) and D6 (moderation works like posts:
[moderation-and-blocking](../moderation-and-blocking.md)). **The broadcaster's rules step is built** (below); the
report control on the viewer, the cut button in `/admin/moderation` and the "cut" screens are BUILT
(client follow-up, below).

| Control | Who | Where | What it does |
| --- | --- | --- | --- |
| **Report a chat line** | any member who may watch the live | `POST /api/moderation/reports` `{ contentType: 'live_chat', contentId: <messageId>, liveId, reason, message }` | [below](#a-reported-chat-line-wp-l8b) |
| **Report a live** | any member the live is visible to | `POST /api/moderation/reports` `{ contentType: 'live', contentId: <liveId>, reason }` | a `content_reports` row - the posts' ONE store, same reason list, same once-per-person-per-thing dedup (`409 ALREADY_REPORTED`). `reportedUserId` is the broadcaster READ FROM THE LIVE ROW, never the client's. The live must still have a row (open, or ended and not yet purged) and be visible to the reporter by [the rule of a post](#who-may-watch-the-rule-of-a-post) with no block, else `404 LIVE_NOT_FOUND`: the report route is no oracle for a live the reporter could not watch. **A viewer the broadcaster REMOVED may still report the live**: what they watched before the removal is theirs to report, and the removal bounds only [a chat line](#a-reported-chat-line-wp-l8b). No auto-hide: a live is CUT by a person, never by a count. A live already deleted (no replay) cannot be reported: the person can. **No rate limit beyond the dedup**, exactly as posts (none exists on `/api/moderation`) |
| **Read the queue** | content moderators | `GET /api/moderation/reports` | a live report carries `live: { state, broadcasterId, broadcasterName, associationId, startedAt, endedAt, endReason, cutReason, broadcasterCuts }` and `contentPreview` = the broadcaster's name. `state`: `open` (the cut button), `ended` (row not yet purged), `cut`, `gone` (ended and purged: nothing left to watch or cut; mute the person). The live's id is the link: the viewer overlay opens a live by id |
| **Cut** (staff remote cut, the live's "delete the post") | `isContentModerator` - a platform admin or a BDE member holding `MODERATE`, the predicate of the posts' moderation controls | `POST /api/lives/:id/cut` | [below](#the-cut) |
| **Remove a viewer** | the broadcaster | `POST /api/lives/:id/removed-viewers` (since WP-L2) | a durable `live_removed_viewers` row: the key, the manifest and the listing refused (`403 LIVE_VIEWER_REMOVED`), the seat freed at once. The viewer client maps it to its "removed" screen. **Not a Redis set with a TTL**: the row IS the state and goes with the live (cascade), so no clock decides it |
| **Block** | either person | core-service `user_blocks` | the live hidden from the list and refused (`404`) both ways, and the push not sent (since WP-L2/L7) |
| **A muted member cannot broadcast** | - | `POST /api/lives` | `403 LIVE_MUTED`, the posting rule (`user_moderation.isMuted`) |
| **A suspended or withdrawn broadcaster cannot broadcast** | - | `POST /api/lives` | `403 LIVE_BROADCAST_SUSPENDED` / `LIVE_BROADCAST_WITHDRAWN` ([the ladder](#the-strike-ladder-wp-l8b)) - broadcasting only, posts and the chat untouched |
| **First-live rules** (L11) | the broadcaster | `POST /api/lives` `acceptedRulesVersion`, `GET /api/lives/rules` | [below](#the-first-live-rules-l11) |
| **Hide a chat message** | the broadcaster or staff | WP-L6, built (C14) | [the chat](#live-chat-and-floating-reactions-wp-l6) |

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
(`post_notifications` type `live_cut`, `text` = the reason CODE, no actor) **and its push**
([the ladder's pushes](#the-three-pushes-a-broadcaster-gets-wp-l8b)). The broadcaster's own screen
learns it at once from the `410` its next segment gets.

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
filed in [backlog](../backlog.d/p1-live-moderation-wp-l8-merged-the-client-s-standing-refusals-the-vie.md).

**Repeat offenders: [the strike ladder](#the-strike-ladder-wp-l8b)**, built 2026-10-21 on the
decisions of 2026-10-20. Step 1 above records the cut's STRIKE, and the notice after the commit is
the ladder's.

### The strike ladder (WP-L8b)

The user's ladder (2026-10-20): **1st cut, a warning and the live cut; 2nd, the right to broadcast
SUSPENDED 30 days; 3rd, the right WITHDRAWN by staff decision**, counting the cuts still on record (a
rolling 90 days). No automatic cut: every rung starts from a person's cut. Code:
`lives/live-strikes.ts`.

- **The strike is FIXED on the cut row** (`live_cuts.strike`, migration 099): 1 + the
  broadcaster's other cuts on record when it is recorded. The standing is then DERIVED from durable
  rows, never from a flag with a clock: **suspended** = a cut with `strike >= 2` whose `cutAt + 30
  days` is still ahead (`suspendedUntil` the latest such end); **withdrawn** = a
  `live_broadcast_withdrawals` row. Fixing the strike is what makes the 90-day prune of an OLDER cut
  unable to lift a running suspension, and a suspension ends by the row aging, nothing sweeping it.
  The existing cut rows read strike 1 (the column's default): nothing they decided changes.
- **Strike 3 and later also suspend**, and the answer says `withdrawalDue` (3 cuts on record, not
  withdrawn): the withdrawal is a moderator's decision, `POST /api/lives/broadcasters/:userId/withdrawal`
  (409 `LIVE_WITHDRAWAL_NOT_DUE` below 3 cuts - the ladder is the owner's), lifted by `DELETE` on the
  same path. A withdrawal does NOT end a live already open: staff cut it, which is its own act.
- **Order**: a cut and a start both take the per-account advisory lock
  `pg_advisory_xact_lock(hashtextextended('live_standing:' || id, 0))` BEFORE the live's row lock, so
  two cuts of one broadcaster's lives are strikes 1 and 2, never 1 and 1, and a start racing a cut
  either commits first (then is cut) or reads the new standing. Proven on PostgreSQL.
- **A start** reads the standing under that lock, after the mute, the association right and the
  rules, before the hourly rate: `403 LIVE_BROADCAST_WITHDRAWN`, else `403 LIVE_BROADCAST_SUSPENDED`
  `{ suspendedUntil }`. `GET /api/lives/standing` is the caller's own standing.
- **The notice** (`post_notifications`, `text` = the reason code, no actor) **and its push**: `live_cut`
  for strike 1 when the cut ended the live (as before); **`live_suspended`** for strike 2 and later
  (whether or not the live was still open: a suspension is news either way); **`live_withdrawn`** at a
  withdrawal. A strike-1 cut of a live the broadcaster had already ended is not notified (unchanged).
  The bell rows for all three are built (`NotificationRow`, `notif_live_*_text`, the reason label).

### The three pushes a broadcaster gets (WP-L8b)

Built 2026-10-21. The three notices above are pushed through the one pipeline
(`PostNotificationsService.createNotification` -> `pushContent`), no longer `skipPush`:

| Notice | `contentKey` | FR (EN) |
| --- | --- | --- |
| `live_cut` | `social_live_cut` | "Votre live a été interrompu" / "La modération a coupé votre live. Ceci est un avertissement." ("Your live was stopped" / "Moderators cut your live. This is a warning.") |
| `live_suspended` | `social_live_suspended` | "Lives suspendus" / "Après une nouvelle coupure par la modération, vous ne pouvez plus lancer de live pour le moment." ("Lives suspended" / "After another cut by moderators, you cannot start a live for now.") |
| `live_withdrawn` | `social_live_withdrawn` | "Droit de lancer un live retiré" / "La modération vous a retiré le droit de lancer un live." ("Right to go live withdrawn" / "Moderators have withdrawn your right to start a live.") |

- **Fixed sentences, composed on the device** (`notif_social_live_*` on Android, `notif.social.live_*`
  in the iOS app and NSE, fr + en): no actor (which moderator acted is not the broadcaster's to
  read), no fragment (the reason is a WORD, worded by the bell row), **no icon** (nobody to show; an
  empty user id would be a present key with nothing to fetch). The server's French rides along as
  `title`/`body` for builds without the keys. Pinned by `push-content.spec.ts` (legacy French =
  the Android table) and `nativeStrings.test.ts` (every table, every composer).
- **The tap opens the notifications list**: `pushData.target = 'notifications'` (`NOTIFICATIONS_TARGET`,
  `push-target.ts`) wins over `postId`, which is the live's id (or the member's, for a withdrawal) -
  a `post/<id>` link would open a post that does not exist. The `notifications` host is declared in
  `tauri.conf.json` and the Android manifest (`deepLinkHostsDeclared.test.ts`) and routed by
  `appRouteForDeepLink`. What a build older than that change does with the tap is EXPECTED, not
  observed: the Android deep-link plugin should drop the undeclared host, and elsewhere the hook's
  unknown-host branch should land on the list.
- **Never muted BY CANARI**: the three keys are deliberately absent from chat-delivery's
  `push-category.ts`, so no in-app notification setting silences a sanction on the reader's own
  account (`push-category.spec.ts`). That holds on the server only: on Android they draw on the
  social notification channel (`CHANNEL_SOCIAL`), so a member who turned that channel off in the
  system settings does not see them - the in-app row on the notifications list remains.
- **The 30 days are not in any sentence**: the suspension's end is `GET /api/lives/standing`'s to
  say, so a change of `LIVE_SUSPENSION_MS` changes no table.
- **The queue** carries `live.broadcasterStanding` (`{ cutsOnRecord, suspendedUntil, withdrawnAt,
  withdrawalDue }`) beside `broadcasterCuts`, which is now the WINDOWED count.
- **Per-account start limits** are the ones that existed: 6 starts in a rolling hour and one open
  live (above). The ladder adds the suspension and the withdrawal; nothing else was asked.
- **Erasure**: the account's cuts and its withdrawal row are deleted; a withdrawal it DECIDED as a
  moderator is anonymised (the decision stays). A withdrawal holds the account's cuts `FOR SHARE`
  before counting them, so an erasure in flight (which deletes the cuts before the withdrawal rows)
  either waits for it or is waited for and leaves it nothing to count: no row outlives an erasure.

### A reported chat line (WP-L8b)

The user's decision of 2026-10-20 ([below](#a-reported-chat-line-is-kept-until-handled-reverses-c2)),
built 2026-10-21. **The live key is NOT kept**; the reporter's client hands over the plaintext it
sees, and the server CHECKS it before keeping anything.

`POST /api/moderation/reports` `{ contentType: 'live_chat', contentId: <messageId>, liveId, reason,
details?, message: <the plaintext line> }`, in ONE transaction:

1. the message row is read; its live must be `liveId` when one is given;
2. the live must still have a row and be visible to the reporter with no block (the `live` report's
   own check, `FOR SHARE`); the message must still be there, NOT hidden, and its author not blocked
   either way; for a reporter the broadcaster REMOVED, the line must be written no later than their
   `removedAt` (compared in SQL: a line written after it was never served to them, and one before
   it was seen legitimately). **Every one of these is `404 LIVE_NOT_FOUND`** - no oracle, and what
   the client reads as "close the dialog"; the server's `debug` line names which one refused;
3. the server OPENS the sealed line with the live key (`live-chat-seal.ts`, the client's v1 format,
   pinned by a known-answer vector both sides open) and compares it to `message`, byte for byte:
   **`400 LIVE_CHAT_REPORT_MISMATCH`** if they differ (a `warn` the first time per reporter and
   line, `debug` for a repeat; the set remembering it is cleared at 1000 pairs, never by a timer). So a kept line is what the author
   sealed, not what the reporter typed;
4. the `content_reports` row (the posts' ONE store and dedup, `409 ALREADY_REPORTED`;
   `reportedUserId` = the author READ FROM THE ROW). Two concurrent reports that both pass the
   dedup's read meet the unique index `content_reports_reporter_content_uniq` (migration 099,
   partial: the erased tombstone is left out, so two erased reporters never collide), mapped to the
   same `409`;
5. the kept line, `live_chat_reported_lines`: the text (as its UTF-8 BYTES, a `bytea`: a PostgreSQL
   `text` cannot hold U+0000, which a sealed line may carry, and a NUL must not make a line
   unreportable; the signature is over the decoded string), the live, the message id, its `seq`, its
   author, its `clientId`, its time, `keptAt` (read from the database clock in the same transaction,
   to the millisecond) and the SHA-256 of the sealed bytes - **not the ciphertext and not the key** -
   signed by three HMAC-SHA256 (`live-report-signature.ts`) under `LIVE_REPORT_SIGNING_KEY`: one over
   the content (`keptAt` included, since the 90-day bound counts from it), one over the report and
   the AUTHOR, one over the report and the REPORTER. The key is named by `keyId`, an HMAC of a fixed
   label under the key (never a plain hash of it).

Other answers: `400 LIVE_CHAT_REPORT_MESSAGE_INVALID` (`message` absent, empty, or over **900 UTF-8
bytes** - `LIVE_CHAT_REPORT_TEXT_MAX_BYTES`, what the largest STORED sealed line holds, so every line
a viewer can see is reportable; the composer's 300 characters bind the sender's client, not this), the DTO's `400` on a malformed `liveId`, **`503 LIVE_REPORT_SIGNING_UNAVAILABLE`** when
the key is not configured (an `error`, nothing kept - the env manifest makes it REQUIRED in both
estates).

**What staff see**: the queue's `live_chat` report carries `contentPreview` = the kept text and
`liveChat: { liveId, messageId, seq, authorId, authorName, text, messageCreatedAt, keptAt, keptUntil,
integrity: { content, author, reporter } }`. `content` is `verified`, `altered` (the row changed in
the database) or `key-rotated` (signed under another key: still readable, its proof is not);
`author` and `reporter` add `erased` - ONLY when that id is the erased tombstone, so an id rewritten
to another account reads `altered` even when the other account was erased (review of #2172). Every
verdict reads `unverifiable` while the estate has no signing key (logged at `error`).

**What the verdicts cannot tell apart, stated.** `key-rotated` means only "the stored `keyId` is not
the current key's": a row whose `keyId` was itself rewritten reads the same, and a list of retired
ids would not close it, since a writer can copy a genuinely retired id. So **`key-rotated` and
`unverifiable` are PROOF ABSENT and must be shown to a moderator with the weight of `altered`**,
never as a lesser doubt. And an account id rewritten TO the tombstone reads `erased`, exactly as a
real erasure does. A signature proves the SERVER recorded that text
after checking it against the sealed line; it is not a signature by the author.

**How long**: until the report is handled (`status` no longer `pending`), and **never more than 90
days** from `keptAt` - both erased by the live sweep (step 4 above), so within 30 s of the handling.
The line does not go with the live (no foreign key to `lives`) and goes with its report (a cascading
foreign key). A cut does not mark `live_chat` reports reviewed: a line is its own report. Nothing
hides a line automatically.

**The AUTHOR's erasure** anonymises `authorId` on the kept line and leaves it until handled or the
90 days (the user, 2026-10-20): the report stays judgeable. The REPORTER's erasure anonymises the
report's `reporterId` (the posts' rule for `content_reports`) and the line stays the same way; in
both cases that account's signature alone reads `erased`. Register row C20 states it.

### The 24 h alarm on the live report queue (WP-L8b item e)

The owner's commitment to the stores (2026-10-20): a live report is answered within **24 hours on
working days**. Until 2026-10-21 nothing measured it. `LiveReportAgeScheduler`
(`lives/live-report-age.scheduler.ts`), hourly at :53, reads every PENDING `live` and `live_chat`
report and prints ONE line:

| Queue | Level | Line |
| --- | --- | --- |
| empty | `log` | `[LIVE_REPORT_AGE] pending=0` - printed anyway, so an alarm that stopped never reads as an empty queue |
| every report inside the commitment | `log` | `pending=<n> overdue=0 oldest=<h>h working (<h>h wall), inside the 24.0h` |
| one or more past it | **`error`**, every hour until answered | `pending=<n> overdue=<k> oldest=<h>h working (<h>h wall): <k> live report(s) past the 24.0h working-day commitment to the stores - answer them in /admin/moderation` |
| the queue cannot be read | **`error`** | `could not read the live report queue - the 24 h commitment is unwatched this hour` |

- **No user data**: no report id, no account, no reason - counts and ages. The queue is where a
  moderator goes from it.
- **Working time, not wall time** (`workingMsBetween`, `lives/live-report-age.ts`): the parts of
  the age that fall Monday to Friday in `Europe/Paris`, each day cut at the zone's own midnights, so
  a report filed on a Friday evening is not late on Sunday. A span crossing a weekend that holds a
  daylight-saving change is tested and exact (2026-10-23 to 26: 73 h on the wall, 24 h of work).
  **Public holidays count as working days** - no calendar of them exists here - so the
  alarm may fire a day EARLY around one, never late. Overdue is strictly past 24 h.
- **One clock, the database's**: `now()` and the creation instants come from one statement.
  `content_reports."createdAt"` is a `timestamp` without zone written by `now()`; `::timestamptz`
  reads it back in the same session zone, so the instant is exact (asserted on PostgreSQL: a report
  moved ten days back reads ten days, to the minute).
- Runs whatever `LIVE_ENABLED` says, like the sweep: a report filed while the switch was on is still
  owed its answer. Purely a report: it changes nothing.

Pinned by `live-report-age.spec.ts` (the arithmetic across a weekend and the October DST night, the
three levels, no id in the line) and `lives.integration.spec.ts` (the SQL: only pending live and
live_chat reports, the cast).

### The first-live rules (L11)

`live_rules_acceptances`: one row per account, the version accepted and when. A start is refused
`403 LIVE_RULES_NOT_ACCEPTED` `{ rulesVersion }` unless the recorded version is at least
`LIVE_RULES_VERSION`, or the start carries `acceptedRulesVersion` EQUAL to it - which records it
(raised, never lowered), even if the start is then refused for another reason (rate, an open live):
the acceptance happened. Any other value (an older version, a string) is refused: a client showing
older rules has not shown these. Checked AFTER the mute and the association right, so a muted member
records nothing. `GET /api/lives/rules` tells the pre-live screen whether to show them. **Raise
`LIVE_RULES_VERSION` when the rules' TEXT changes**; every member then accepts once more.

**THE CLIENT (built, `LiveBroadcast` and `LiveBroadcaster.svelte`):** the pre-live screen reads
`GET /api/lives/rules` with the limits (either failing is the same "could not read" with its
Retry). While `acceptedVersion` is below `version`, a rules sheet (no harassment, nothing illegal,
moderators can cut, you are responsible: `live_rules_*`) replaces Start with "I accept the rules";
the start then sends `acceptedRulesVersion: version`, and only then. A `403
LIVE_RULES_NOT_ACCEPTED` (the version raised since the read) re-reads the rules and shows the sheet
again with `live_start_rules_not_accepted`; `LIVE_MUTED` keeps its own sentence.

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
- **Staff reach**: a cut ends the chat with the live; a single line is reported as `live_chat`
  ([above](#a-reported-chat-line-wp-l8b)).

### What the client still owes (strings for Paraglide)

The cut screens, the `live_cut` bell row, the `LiveRefusalError.endReason` field, the admin queue's
live row and cut button and the `LiveEndReason` / `LiveRefusalCode` additions are BUILT
([the moderation client](../frontend/modules/live.md#the-moderation-client-wp-l8s-client-half-2026-10-19)).
What is left:

- **The ladder's screens** (WP-L8b; the three pushes and the two bell rows are
  [built](#the-three-pushes-a-broadcaster-gets-wp-l8b)): the two start refusals (`LIVE_BROADCAST_SUSPENDED` with its date, `LIVE_BROADCAST_WITHDRAWN`) and the
  pre-live screen reading `GET /api/lives/standing`; in `/admin/moderation`, the standing on a live
  report and the withdraw / lift buttons, and the `live_chat` row with its integrity - `altered`,
  `key-rotated` and `unverifiable` shown with ONE weight, "not proven" ([why](#a-reported-chat-line-wp-l8b)).

## Decisions of 2026-10-20: moderation, reactions, the audience

The user's answers to the open moderation questions. **The ladder, the 90 days, the reported line
and the reactions are BUILT (2026-10-21, server)**, and so is [the 24 h alarm](#the-24-h-alarm-on-the-live-report-queue-wp-l8b-item-e); the viewer cap is not - WP-L8b in the
[backlog](../backlog.d/p1-live-moderation-wp-l8-merged-the-client-s-standing-refusals-the-vie.md).

| Question | Decision | What it changes in what exists |
| --- | --- | --- |
| Strike policy | **Warning, then suspension, then withdrawal.** 1st abuse: a warning and the live is cut. 2nd: the right to broadcast is SUSPENDED. 3rd: the right is WITHDRAWN, **decided by staff** | **BUILT** ([the ladder](#the-strike-ladder-wp-l8b)). **A suspension lasts 30 days** (decided 2026-10-20) |
| Cut retention | **90 days** | **BUILT**: `LIVE_CUT_RETENTION_MS` is 90 days, as register row C20 says. **The ladder counts the cuts still on record: a rolling 90 days**, so an abuse older than 90 days is forgotten (decided 2026-10-20) |
| Automatic cut on N reports | **No** - staff cut by hand only | Matches the code (a live is never cut by a count); posts keep their own auto-hide at 5 |
| Response time to the stores | **24 hours on WORKING DAYS** for live reports (decided 2026-10-20) | **BUILT 2026-10-21**: the [hourly alarm](#the-24-h-alarm-on-the-live-report-queue-wp-l8b-item-e) names the oldest pending live report's working age at `error` once it is past 24 h |
| First-live rules text | **The posts' publication rules, no live-specific clause** | The sheet's four `live_rules_*` lines are live-specific. **No standalone "posts publication rules" text exists**: what posts are judged by is the terms of use, section 6 ([moderation-and-blocking](../moderation-and-blocking.md)); the sheet must show or link that text. **`LIVE_RULES_VERSION` is 2 since 2026-10-21** (the client sheet that shows it is #2170), so every member accepts once more |
| Viewer cap | **None wanted** ("Je ne veux pas de plafond") | The cap is 24 and stays in code until the [plan](../frontend/modules/live.md#uncapped-audience---the-plan-2026-10-20) is measured; it is the wish of L8 (2026-10-15) again, which the cap was the honest answer to |

### A reported chat line is kept until handled (REVERSES C2)

**Decided:** a chat message that is REPORTED is KEPT, encrypted, for staff, until the report is
handled, then ERASED; every other message vanishes with the live. This reverses C2's "no grace period:
a reported message is gone with its live", which was the lead's choice, not the user's. What it
implies - **BUILT 2026-10-21 as [a reported chat line](#a-reported-chat-line-wp-l8b)**, which settles each point below (the hard ceiling: 90 days):

- **The cascade must stop at a reported line.** `live_chat_messages` has a FOREIGN KEY on the live
  that CASCADES (C1), so the line must be COPIED into a table that does not cascade, at report time,
  with its author, its `clientId` and the report id. Erasure is then ONE rule on durable state: the
  report's handled flag, never a timer.
- **The line is read WITHOUT keeping the live key (chosen design, 2026-10-20).** The reporter's client
  hands over the plaintext it sees, and the server SIGNS what it received so staff can tell it from
  an invention; the live key still goes with the live row. The signature binds the plaintext to the
  live, the message's sequence and author, the sealed bytes the server holds and the reporter - and
  it proves only that this reporter submitted that text, never that the author wrote it. Server
  work (WP-L8b): the hand-over route, the signing key and its rotation, and a staff view that says
  "as reported by X". This gives the server plaintext it never had, so `message`
  entering a report is a privacy decision the terms and register row C20 must state.
- **A new report type** (`live_chat`, naming the live and the message, once per person per message)
  and a staff view showing the line to a moderator, who then reads text the server could not before.
  The terms, the privacy policy and register row C20 must say so.
- **"Until handled" has no upper bound.** Handled is a person's act; an unhandled report would keep a
  private message for ever. The 24 h commitment bounds it in practice, and a pending report older
  than that is the alarm (WP-L8b item e). **STILL OPEN whether to add a hard ceiling.**
- **An erased account** (the erasure statements) must also erase its kept lines and the copies tied
  to its reports, or the erasure is incomplete.

### The five reactions of 2026-10-20

**Decided:** heart, laugh, bravo (clap), fire and the canary chick (🐤). C8's "no sad, no angry" holds.
**BUILT (server, 2026-10-21): `LIVE_REACTION_KINDS` = `like`, `laugh`, `clap`, `fire`, `canari`**, and
`limits.reactionKinds` follows; the client set is #2170.
**C8 said these are "five of the post reaction set", and that is no longer true**: the posts' set
(`frontend/src/lib/posts/reactions.ts`) has no clap and no fire, so two kinds need new ASCII wire
names, labels, Noto pictures ([emoji](../frontend/emoji.md)) and an entry in `LIVE_REACTION_KINDS`;
`love` and `happy` leave the list. A burst of an old kind from an older client is then refused
`400 LIVE_REACTION_INVALID` - dev builds only today, so nothing in the field breaks.

## A deleted account

`LIVES_ERASURE_STATEMENTS` (social `account-erasure.ts`): a live the account broadcast is ENDED
(`erased`, unless already ended) and its broadcaster becomes `[deleted]` **in one statement**, so an
open live never carries the tombstone and the one-open-live index never sees two; the sweep deletes
its segments and row within one run. The account's place on another live's removed-viewer list is
deleted, and so are its `live_starts` rows and its live chat messages and reaction bursts on any
live (WP-L6, after `lives_broadcaster`: the lock order every chat write takes). The cuts OF its lives (`live_cuts`), its withdrawal row and its first-live rules
acceptance are deleted; a cut or a withdrawal it MADE as a moderator is anonymised (the decision
stays); a reported chat line it WROTE is anonymised and kept until handled or 90 days (WP-L8b). Lock order:
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
| **The switch** | Nothing is sent unless `LIVE_ENABLED` is `true` (checked by the announcer itself, on top of the ingest route's own guard): open on both estates since the production flip of 2026-10-30, and the ingest that claims also sits behind `lives_mode`. |

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

## Live chat and floating reactions (WP-L6)

Wanted by the user on 2026-10-19 (D5 of the [plan](../frontend/modules/live.md#decisions-of-2026-10-19)):
comments and floating reactions on a live, the chat **encrypted with the live key** (L4), **ephemeral**,
moderated **like posts** (D6: the broadcaster hides a message and removes a viewer, staff may act).
Designed and built 2026-10-19 by the lead on the user's instruction to take the decisions; each one
below is reversible and names its reason.

### The decisions

| # | Question | Decision | Why |
| --- | --- | --- | --- |
| C1 | **Storage** | **PostgreSQL rows** (`live_chat_messages`, `live_reaction_bursts`, migration 098), with a FOREIGN KEY on the live that CASCADES - not a Redis ring buffer | Every rule a chat needs is already a row rule here: the order is the live's row lock (C4), idempotence is a unique index (C5), the rate is a COUNT of durable rows (C6), the account erasure is two SQL statements its coverage spec sees, and the retention is the live row's own deletion (C2). A Redis list would need its own erasure scan, its own idempotence keys and its own expiry - three mechanisms the row gets for free. Redis stays what it is here: the seat counter. |
| C2 | **Retention** | **REVERSED IN PART 2026-10-20 by the user: a REPORTED line is kept until handled ([below](#a-reported-chat-line-is-kept-until-handled-reverses-c2)); the rest of this row is what the code still does.** **Erased with the live, at its end** - by the cascade when the live's row is deleted (at once at the broadcaster's end, or by the 30 s sweep). **No 24 h grace, no replay of the chat** | L3 (no replay): an ended live answers `410` to every read, so a kept message is one nobody can ever read again - except the server, which holds the live key. Keeping it would only serve a moderator reading a report after the end, and the report path (WP-L8) owns what it keeps. **The longest a message lives is the live (60 min at most) plus the purge** (seconds, or until the media store proves the segments gone - the row waits for that proof, lives.md "Deletion"). Database backups may hold the rows of a live that crossed a nightly dump (register C19). |
| C3 | **Transport** | **The manifest poll the viewer already makes, once a second**: `GET /api/lives/:id/manifest?chat=1&messagesAfter=<seq>&reactionsAfter=<seq>` carries a `chat` block. **Not the WebSocket gateway, and not a second endpoint** | ONE request per viewer per tick, not two: 24 viewers are 24 requests a second either way, each with an `auth_request` sub-request, and a sibling route would double both. The gateway (chat-delivery) routes MLS frames to DEVICES of CONVERSATIONS; a live's audience is a visibility predicate in social-service (spaces, blocks, removals) the gateway knows nothing of, so a WebSocket fan-out would need a per-viewer filter in a second service, a resubscription on every reconnect, and a catch-up read on HTTP anyway for a late joiner. The picture is already 5-10 s behind (option C), so the 1 s poll adds at most a second to a chat that is ahead of the video. No timer is added: the cursor is a sequence number (C4), so a lost poll loses nothing. The nginx limits are untouched: `/api/lives` limits only `PUT` per address (`lives_ingest`), and `limit_conn ... 24` is the SEGMENT location's alone. |
| C4 | **Order** | A **server sequence per live** - `lives."chatSeq"` for messages, `lives."reactionSeq"` for reaction bursts - incremented under the live's ROW LOCK in the same transaction that inserts the row | A `bigserial` would number rows in the order they START and commit them in any order, so a poller reading "after 10" while 10 is still uncommitted and 11 is visible would skip 10 for ever. Under the row lock, a sequence number is allocated and committed in one order, so any snapshot sees a gapless PREFIX and the cursor "the highest seq I was given" can never skip a row. The lock is the one every other write of a live takes (lives.md "The end is the row's state"), so a post also serialises against the end and a removal (C9). |
| C5 | **Idempotence** | The client's `clientId` (a uuid) is unique per `(live, author)`; a repeat with the same sealed bytes answers the stored message, other bytes are `409 LIVE_MESSAGE_CONFLICT`. A reaction burst carries a `burstId`, unique the same way | Durable state, never a clock (CLAUDE.md). A lost answer retried is the same row, not a second message. |
| C6 | **Rate limits, per account per live** | **3 messages per rolling 5 s**; **2 reaction bursts and 10 taps per rolling 2 s** - counted from the rows themselves under the row lock (the database clock), `429 LIVE_MESSAGE_TOO_FAST` / `429 LIVE_REACTION_TOO_FAST`, each with `retryAfterMs` - when the OLDEST row of the window leaves it, read from the rows by the database clock, never a constant | A count held in durable state, as the segment rate is. 10 taps per 2 s is 5 a second, faster than a thumb sustains; the client sends at most one burst per poll tick (1 s), so two per window leaves room for jitter. |
| C7 | **Reactions are aggregated by the SERVER** | A tap is never an event: the client sums its taps and sends ONE burst `{ burstId, counts: { like: 3 } }` per tick at most; the poll answers `reactions: [{ window, counts }]`, the sums of every burst since the cursor **per 2 s window** (`window` = the burst's age into the live in 2 s steps), minus the viewer's own bursts (already drawn by its own client) and minus bursts of accounts blocked either way | One aggregate per window per poll, whatever the audience: 24 viewers tapping produce one small object a second, never 24 x taps events. |
| C8 | **The five reaction kinds** | **The user's list of 2026-10-20 ([below](#the-five-reactions-of-2026-10-20))**: `like` ❤️, `laugh` 😂, `clap` 👏, `fire` 🔥, `canari` 🐤, drawn with the Noto SVG pictures every emoji uses ([emoji](../frontend/emoji.md)). `love` and `happy` (the first set) are refused `400 LIVE_REACTION_INVALID` | ASCII wire names (a new wire, so no accented key). Sad and angry are left out of a floating stream on purpose. Server: `LIVE_REACTION_KINDS`. |
| C9 | **Who may post** | Exactly who may WATCH (`assertMayWatch`: the rule of a post, not blocked with the broadcaster, not removed, the live open), **and not muted** (`403 LIVE_MUTED`, the account-level mute of [moderation](../moderation-and-blocking.md), the same code as a muted start). The ended and removed checks are **repeated under the row lock**, so a removal or an end that commits first is never overtaken by a message. **No seat is needed**: a seat is bandwidth, and a message costs none of it | "A banned or removed viewer cannot post" (user): banned is the account mute, removed is the broadcaster's per-live list. |
| C10 | **Blocks between viewers** | A viewer never receives the messages, or the reaction taps, of an account blocked either way (`blockedUserIdsFor`, filtered per poll) | As the feed hides a blocked author. |
| C11 | **Content** | **Plain text only**, at most **300 characters** (UTF-16 units, the client's to enforce before sealing - the server sees ciphertext). The server bounds the SEALED size: 29 to 928 bytes (12 IV + at most 900 UTF-8 bytes + 16 tag). **No link is rendered** (a URL stays text), **no mention in v1**, no media | The server cannot read a message, so length and shape are the client's; the byte bound is what the server CAN hold. A rendered link or a mention would need the server to resolve something it cannot read. |
| C12 | **Encryption** | The message is sealed with the LIVE KEY (AES-256-GCM, fresh 12-byte IV): `iv + ciphertext + tag`, AAD `canari-live-chat-v1` `0x00` + the live id (16 raw bytes) + the `clientId` (16 raw bytes) + the author's account id (UTF-8). Built in `frontend/src/lib/live/liveChatCrypto.ts` (client PR), **owed the same adversarial crypto review as the segment seal** | The AAD binds a message to its live, its author and its idempotence key: a server (or a store) that served one author's ciphertext under another's name, or replayed it on another live, makes it FAIL to open, and the client drops it. Chat lines never reach the media store: they live only in social-service's database, beside the key that opens them, so **the seal gives NO confidentiality against anyone holding that database or its backups**, nor against social-service itself. What it gives is integrity of place and author. Reactions are NOT sealed: the server must add them up (C7), and a kind and a count say nothing a picture on the screen does not. |
| C13 | **A late joiner** | The first poll without `messagesAfter` answers the **newest 50 messages the viewer can SEE** - hidden ones and blocked authors are left out IN THE SQL, BEFORE the limit, so hides never empty a joiner's backlog - and a message cursor that is the live's highest seq (read before the rows, so nothing between is skipped; a row read twice is deduped by the client on `author:clientId`); **no reaction backlog** (`reactionsAfter` absent: the cursor only) | A reaction is a moment; a joiner sees the stream from now. |
| C14 | **Hiding a message** | `POST /api/lives/:id/messages/:messageId/hide`, by the **broadcaster or staff** (`isContentModerator`: a platform admin, or a BDE member holding `MODERATE` - the posts' one moderator predicate, as WP-L8's staff cut uses). It ERASES the ciphertext (`sealed = NULL`, `hiddenAt` set) and gives the row a NEW sequence number, so every viewer's next poll carries a tombstone `{ id, seq, hidden: true }` and removes the line it drew. Idempotent; `404 LIVE_MESSAGE_NOT_FOUND` for a message not on that live; a caller who is neither is `404 LIVE_NOT_FOUND` (no oracle, as every write). **A live STAFF CUT and then purged** answers the broadcaster and staff its `410 LIVE_ENDED` `endReason: 'cut'` from WP-L8's `live_cuts` record (`LivesService.cutOf`), as every live route does | D6. Erasing rather than flagging: nobody may read it again, so nothing keeps it. Re-sequencing is what makes the cursor carry a hide without a second channel. **Removing a viewer and reporting are WP-L8's** (its own pull request), not duplicated here. |
| C15 | **The live ends** | Every chat route answers what the live's other routes answer: `410 LIVE_ENDED` WITH its `endedAt` and `endReason` (WP-L8's one `liveEnded`, so `cut` is told apart), and a write that reaches a live purged after a cut gets that `410 cut` too (`refuseIfCut`); the rows go with the live (C2) | One end, the row's (Q5). |
| C16 | **Push** | **None.** A live message notifies nobody | A live chat is read while watching; a push per message to 24 viewers is noise (CLAUDE.md). |

**What the chat seal does NOT protect, accepted and stated (review of #2136, 2026-10-19).** The
seal (C12) binds a message to its live, its author and its `clientId`, and nothing else:

- **The sequence number is not in the AAD**, so the server (which holds the key anyway) can
  REORDER, DROP or REPLAY messages - a replay under a new id is not drawn twice, since the client
  dedupes on `author:clientId`, but a dropped one is simply never seen.
- **A tombstone is not authenticated**: a hide is the server's word, and moderation is the
  server's job by design (C14). A client cannot tell a moderator's hide from any other removal.
- **The ciphertext length gives away the exact UTF-8 length** of the message (iv 12 + text + tag
  16, no padding).
- **Reactions are PLAINTEXT**: kind counts per member per 2 s window (C7, C12), which the server
  must read to add them up.

Unlike the segments, a chat line is never in the media store: it lives only in social-service's
database, next to the live key. The AAD binds a line to its live, its author and its `clientId`;
there is **NO confidentiality against whoever holds that database or its backups**, nor against
social-service.

### The contract

| Route | Who | Answers |
| --- | --- | --- |
| `GET /api/lives/:id/manifest?chat=1[&messagesAfter=<seq>][&reactionsAfter=<seq>]` | who may watch | the manifest plus `chat: { messages, messagesCursor, reactions, reactionsCursor }`. `messages`: ascending `seq`, at most 100 after the cursor (or the newest 50 without one), each `{ id, seq, authorId, clientId, sealed (base64), createdAt }` or a tombstone `{ id, seq, hidden: true }`. `reactions`: `[{ window, counts: { like?, laugh?, clap?, fire?, canari? } }]`. Pass each cursor back as is. Without `chat=1`, the manifest is unchanged |
| `POST /api/lives/:id/messages` `{ clientId, sealed }` | who may watch, not muted | `201` the message. `400 LIVE_MESSAGE_INVALID` (not a uuid / not base64 / out of 29..928 bytes), `403 LIVE_MUTED`, `409 LIVE_MESSAGE_CONFLICT`, `429 LIVE_MESSAGE_TOO_FAST` (with `retryAfterMs`), and the watch refusals (`404`, `403 LIVE_VIEWER_REMOVED`, `410`) |
| `POST /api/lives/:id/reactions` `{ burstId, counts }` | who may watch, not muted | `201 { burstId, seq }`. `400 LIVE_REACTION_INVALID` (an unknown kind, a count not 1..10, an empty burst), `403 LIVE_MUTED`, `409 LIVE_REACTION_CONFLICT`, `429 LIVE_REACTION_TOO_FAST` (with `retryAfterMs`), the watch refusals |
| `POST /api/lives/:id/messages/:messageId/hide` | the broadcaster, or staff (`isContentModerator`) | `200 { liveId, messageId, hidden: true }`, idempotent; `404 LIVE_MESSAGE_NOT_FOUND`, `404 LIVE_NOT_FOUND`, `410 LIVE_ENDED` |

The numbers (`chatMessageMaxChars`, `chatSealedMaxBytes`, the two rates, `chatBacklog`,
`reactionKinds`, `reactionWindowMs`) are in `GET /api/lives/limits`, from `live.constants.ts`.

### An erased account, and a single message reported

**An erased account's messages stay on the screens that drew them, accepted (review of #2131,
2026-10-19).** The erasure DELETES the rows (no copy is left on the server, and a joiner never
sees them), but it emits no tombstone: a tombstone needs a new sequence number under each live's
row lock, one per message, inside the erasure's transaction. A viewer who already drew such a
message keeps it until it closes the viewer - as long as the live - and nothing can fetch it
again. **Reporting ONE chat message** is `contentType: 'live_chat'` since 2026-10-21 ([a reported
chat line](#a-reported-chat-line-wp-l8b)).

### The row lock, extended

A message, a reaction burst and a hide take the live's row lock (`SELECT ... FOR UPDATE`) FIRST,
like the ingest's two steps, the end and a removal; none of them calls another service inside the
transaction. **The lock is now taken by every chat write**, so an ingest may wait behind a few of
them: each is a few statements with no network in between, bounded by the rates of C6 (24 viewers at
full rate are about 40 short transactions a second on one row, at the worst). Measured: nothing yet -
the first dev reading with several viewers is owed (below).

The account erasure deletes the account's messages and bursts AFTER `lives_broadcaster` (the
lives-then-rows order every chat write takes), so an erasure and a message on the account's own live
wait for each other rather than deadlock. A message whose transaction commits after the erasure's
DELETE was not visible to it and survives - until its live ends (C2).

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

`099_live_strikes_and_reported_chat_lines.sql` (WP-L8b): `live_cuts.strike` (`smallint NOT NULL
DEFAULT 1`, so existing cuts are strike 1, CHECK `>= 1`), and two new tables,
`live_broadcast_withdrawals` (one row per account) and `live_chat_reported_lines` (foreign key to
`content_reports` ON DELETE CASCADE, none to `lives`). Applied twice by the integration spec, and
`synchronize` changes nothing on them (asserted).

`110_live_key_at_rest.sql`: `lives."liveKeyCiphertext"` (text) and `"liveKeyVersion"` (smallint),
`"liveKey"` made NULLABLE (the previous release's replica still writes it during the rolling
deploy), the partial index the backfill reads, and the two CHECKs ([the live key at
rest](#the-live-key-at-rest)). Additive; existing rows satisfy both CHECKs as they are; the sealing
of those rows is the sweep's, not this file's. Applied twice by the integration spec, and
`synchronize` changes nothing (asserted). 110 because 106-109 were held by open pull requests on
2026-10-22.

## What is not proven

- **A scripted broadcaster on dev, through nginx, media-service and Garage, is READ (WP-L1,
  2026-10-19)**: two phones as broadcasters, three viewers at a time, ~2 200 segments, 0 refusals;
  a segment `GET` is ~0.1 s to first byte then ~4 Mb/s on dev's route
  ([live](../frontend/modules/live.md#wp-l1---measured-2026-10-19)). Not read: many viewers, and
  production's route.
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
- **The live chat (WP-L6)** is proven on a real PostgreSQL (`lives.integration.spec.ts`: fifteen
  writers racing a poller - every seq once, gapless; a removal and an end committed past the watch
  check refused under the lock; a hide reaching a cursor as a tombstone; the purge taking every row;
  the erasure) and nothing else: **not through nginx, not with a real client, not under an ingest
  sharing the row lock** - the first reading is several dev viewers chatting during a live.
- The 60 s window, the 4 MiB bound, the 30 s seat lease, the 2.5 Mb/s budget and its 1.5 margin, and the one-second
  segment floor were planning figures; WP-L1 read them on dev (above) and none needed to move.

## See also

- [live](../frontend/modules/live.md) - the plan, the decisions, the work packages
- [reels](reels.md) - the server model this copies (state is the row, blobs then row, a `try` per item)
- [media-streaming-upload](media-streaming-upload.md) - the 8 MiB body invariant the segment bound sits under
- [account-erasure](../account-erasure.md)
