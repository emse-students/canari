# Live - the plan (R4 / decision C9; the server half WP-L2/L3 built 2026-10-18, WP-L7's push and the WP-L5 viewer and broadcaster behind a dev-only switch 2026-10-19)

> **Note 2026-10-19:** lives now come BEFORE the calls revival ([decisions](#decisions-of-2026-10-19)). **Note 2026-10-17:** the user's 2026-10-16 calls decisions - 1:1 calls go peer-to-peer direct with Cloudflare TURN as the fallback - post-date this plan; every "relay-only" and SFU statement below describes the code of 2026-10-15, not the target, and WP-L0 is to be re-read against them.

A member opens the composer, picks **Live**, and the whole Canari network can watch until the
broadcast ends - Facebook-style. This page is the PLAN: what the user decided on 2026-10-15, what the
existing calling bricks really are (read from the code that day), the questions still open for the
user, and the work packages in order. What is built is said where it is: the server half ([lives](../../services/lives.md)), the client foundation and seal, and the viewer and broadcaster behind a dev-only switch (below). It is stage R4 of the CanaReels chantier
([reels C9](reels.md#the-chantier-the-comparison-the-ten-decisions-the-build-order-user-2026-09-29)),
and since 2026-10-19 it no longer waits for the calls revival ([calls](calls.md)).

**Convention on this page: a claim not read in this repository's code or measured is marked
_(unverified)_.** Store policy text, Cloudflare TURN pricing and the host's link speed are among them.

**Canari's public traffic has NOT gone through Cloudflare since the move to the Portail-etu host**:
nginx, ufw and DSI certificates on that host, with nginx rate limiting in place of Cloudflare's
([estate-migration](../../infrastructure/estate-migration.md), section 4). Only the internal admin
names, `dev.canari-emse.fr` and the legacy `canari-emse.fr` redirects still sit behind a Cloudflare
tunnel. **There is no CDN in front of production.** Cloudflare TURN (below) is a separate product,
reached by API, and is unaffected.

## What the user decided (2026-10-15)

| # | Question | The user's answer |
| --- | --- | --- |
| L1 | Who may start a live? | **Any member.** |
| L2 | Who may watch? | **The whole Canari network** - C9: the live's key travels in the row, as a post CEK does. **Narrowed 2026-10-19 by the lead on review (a safe default, reversible): a live RESPECTS SPACES LIKE A POST** - a member's live is watched by, and pushed to, readers sharing a space with the broadcaster; an association's live by the readers the association reaches (its members, its rules, a read grant for watching only). One predicate, `liveVisibleToUserSql` in `spaces/reader-spaces.ts`, gates the list, the key, the manifest and the push ([lives](../../services/lives.md#who-may-watch-the-rule-of-a-post)). |
| L3 | Is a live kept afterwards? | **No replay: a live disappears when it ends.** The broadcaster may save it locally on their own device. |
| L4 | What does the first version carry? | **A short live with a small audience** - tens of viewers, 30 to 60 minutes at most - with an **ephemeral live chat and floating reactions**; the chat is **encrypted with the live's key**. The audience size is superseded by L8 (no cap). |
| L5 | How is a live announced? | **A LIVE card at the top of the feed for everyone**, plus a **push ONLY to the followers** of the member or association broadcasting. |
| L6 | How is a live moderated? | **The broadcaster hides chat messages and removes viewers; any viewer can report; staff can cut a live remotely.** |
| L7 | In what order? | **SUPERSEDED 2026-10-19 by [D1](#decisions-of-2026-10-19): lives come BEFORE the calls revival.** Was: revive calls first, then live. The user added that what mostly blocked calls is that **Apple App Review needs a VIDEO recording showing everything works** (still to do), on top of our own tests. |
| L8 | Is there a viewer cap? | **No cap** - *"pas de plafond, mais la qualité du live ne sera pas si grande si ? quelle techno utilisent Twitch ou Facebook ?"*. **This CONFLICTS with what exists**: the call path sends one stream per viewer through Cloudflare TURN against a ~950 GB monthly budget ([below](#what-exists-read-from-the-code-on-2026-10-15)), and any other path still leaves through the host's own uplink, which is unknown and shared with the DSI. It is what forces the [architecture choice](#architecture-options-for-an-uncapped-audience), and the honest answer is **a cap set by the host's uplink, to be MEASURED**. |
| L9 | How many lives at the same time? | **No cap.** |
| L10 | Who is a follower, for the push? | **The existing relations**: `user_follows` for a member, `association_follows` for an association, minus `association_push_mutes`. |
| L11 | Safety rules? | **Report, block, staff cut-off, and rules accepted before a member's first live.** Canari users are all adults (an engineering school, admission after prépa at the earliest), so **no age gate**. |

## What exists, read from the code on 2026-10-15

| Brick | What the code says | Where |
| --- | --- | --- |
| SFU | `call-service`, Rust/Axum/webrtc-rs 0.17. Every track a peer publishes becomes one `TrackLocalStaticRTP` that is `add_track`ed to **every other peer in the room**, each followed by a renegotiation. So it IS one-to-many, but **symmetric**: there is no publisher/viewer role, any joined peer that sends media is fanned out to everyone. | `apps/call-service/src/main.rs` (`on_track`, the loop over `room.peers`) |
| Simulcast | **None.** One encoding per track, forwarded as received; no layer selection. A slow viewer gets the same bitrate as a fast one, and its PLIs reach the publisher. | `main.rs` (no simulcast/RID handling) |
| Keyframes | Subscriber PLI/FIR is relayed to the publisher, plus a coalesced 3 s recovery timer. With N viewers, every viewer's PLI lands on the broadcaster's encoder. | `forward_pli_from_subscriber`, `periodic_keyframe_recovery` |
| Room access | `Join { room_id, room_token }`; the token is an HS256 JWT minted by chat-delivery `POST /api/calls/initiate` after a **group membership** check, valid 5 min. A live has no group, so this gate does not fit as is. | [call-service](../../services/call-service.md#websocket-protocol), [calls](calls.md#api-endpoints-chat-delivery-service) |
| Frame E2E | `CallService.ts` derives the key with `mlsService.exportSecret(groupId, 'mls-webrtc-media', callId, 32)` and applies AES-GCM in a worker through `RTCRtpScriptTransform` (or `createEncodedStreams`). **An MLS exporter needs an MLS group, and the network is not one**, so a live needs a different key source (L2: the key in the row). | `frontend/src/lib/services/CallService.ts` `setupEncryption`, `workers/encryption.worker.ts` |
| A silent cleartext path | When `RTCRtpScriptTransform` is missing or `VITE_CALL_E2E_ENCRYPTION=false`, the client logs and sends media **unencrypted** through the SFU. Under the project's no-fallback rule this must not carry over to live: no transform, no broadcast. | `CallService.ts` `attachMediaTransforms` |
| TURN provider | **Cloudflare TURN (the Calls/Realtime TURN service), a SaaS reached by API**, not the Cloudflare proxy: both `call-service` and chat-delivery mint credentials at `https://rtc.live.cloudflare.com/v1/turn/keys/{id}/credentials/generate-ice-servers`, and the production compose passes `CLOUDFLARE_CALLS_API_TOKEN` / `CLOUDFLARE_TURN_KEY_ID` to both. **No TURN server runs on the host** (`coturn` is in the LOCAL compose only). Whether the production secrets are set today is _(unverified: read from the compose, not the box)_. | `main.rs` `fetch_cloudflare_ice_servers`, `calls.service.ts`, `infrastructure/docker-compose.prod.yml` |
| TURN path | **Both ends are relay-only**: the client sets `iceTransportPolicy: 'relay'`, the SFU selects `RTCIceTransportPolicy::Relay` when a TURN server is configured. So **every media byte, broadcaster in and each viewer out, crosses Cloudflare TURN** - viewers do not pull from the SFU directly. Whether the host may reach Cloudflare TURN over UDP at all is _(unverified)_: its outbound traffic is filtered upstream (TCP 7844 to Cloudflare was found blocked, [estate-migration](../../infrastructure/estate-migration.md)). | `CallService.ts`, `main.rs` `create_peer_connection` |
| TURN budget | chat-delivery refuses new credentials once a monthly counter reaches `CLOUDFLARE_TURN_MONTHLY_BUDGET_GB` (default 950, "Cloudflare free tier is ~1000 GB" per its comment, _(unverified)_ against Cloudflare's current terms). It concerns the TURN product only, so **it binds option A alone**. | `apps/chat-delivery-service/src/services/calls.service.ts` |
| Inbound UDP on the host | Not requested: TURN/UDP to the Portail-etu host "goes in its own request when calls are revived". | [estate-migration](../../infrastructure/estate-migration.md) |
| Host capacity | 4 vCPU, 11 G RAM shared with prod, dev, Le Cercle, Authentik and the DSI's co-tenant sites. **The uplink speed and any egress cap are not documented anywhere** _(unverified)_. | [estate-migration](../../infrastructure/estate-migration.md), [storage-and-retention](../../infrastructure/storage-and-retention.md) |
| Followers | Both relations exist: `user_follows` and `association_follows`, plus `association_push_mutes`. | `apps/social-service/src/follows/entities/` |
| Reports | `content_reports` (social-service) is the only report store. | [moderation-and-blocking](../../moderation-and-blocking.md) |
| State of calls | `CALLS_ENABLED = false` since 0.14.15; five switches move together; the SFU has never placed a real call; webrtc 0.20 is a port, not a bump. | [calls](calls.md) |

**The egress arithmetic, which is an ESTIMATE until a bench measures it.** The ~1.5 Mb/s per viewer
of C9 is a planning figure, not a measurement. Whatever the path, **the host sends one copy per
viewer**:

```
egress(Mb/s) = viewers x bitrate(Mb/s)          (summed over simultaneous lives)
max viewers  = usable uplink(Mb/s) / bitrate     usable = the share of the host's link left to Canari
```

At 2.5 Mb/s (720p, as C3), 100 Mb/s of usable uplink is 40 viewers and 1 Gb/s is 400 - **and the
usable figure is unknown**, because the link speed is undocumented and the link is shared with the
DSI's co-tenants. For option A the same bytes are also billed to Cloudflare TURN: 30 viewers for
60 minutes at 1.5 Mb/s is 45 Mb/s x 3600 s = about **20 GB per live-hour**, so the default 950 GB
budget is roughly **45 such lives a month**, shared with every call. Whether Cloudflare counts the
SFU-to-TURN leg and the TURN-to-viewer leg separately is _(unverified)_.

## Architecture options for an uncapped audience

L8 (no viewer cap) and L9 (no cap on simultaneous lives) cannot be met by the call path as it is
built, and **no path on this host removes the cap: it moves it to the uplink** (formula above).
Three shapes, compared honestly.

| | A - WebRTC through our SFU | B - what Twitch and Facebook do | C - B without server transcoding (Canari variant) |
| --- | --- | --- | --- |
| Ingest | WebRTC to `call-service` | RTMP or WebRTC (WHIP) to an ingest server _(unverified: public descriptions, not read)_ | the broadcaster's phone encodes ONE quality (720p, as C3 for reels) into short fMP4 segments, seals each with the live key, uploads them like encrypted media parts |
| Server work | forwards every packet to every viewer | **transcodes** into several qualities, packages HLS/DASH | **stores only** - no transcoding, consistent with C3 |
| Delivery | one stream per viewer, relay-only through Cloudflare TURN (verified above) | identical cacheable segments through a CDN | identical sealed segments served as files by **our nginx on the host** - there is no CDN in front of production |
| Latency | sub-second | ~2-6 s with low-latency HLS, more with classic HLS _(unverified)_ | **~5-10 s** _(estimate: segment length + upload + polling; to be measured)_ |
| Quality | one bitrate for all (no simulcast) | adaptive bitrate, several tiers | **one quality for all**; a viewer on a weak network stalls or buffers rather than dropping to a lower tier |
| Cost per extra viewer | a WebRTC peer connection in the SFU process, plus a full stream through the host AND through TURN (~950 GB/month shared with calls) | a CDN hit | one file read answered by nginx (no app, no database, no media process) - but still **one copy out of the host's uplink** |
| Scales to | **tens** of viewers | very large audiences | **uplink / bitrate** viewers (formula above), unknown until measured; not the whole network |
| Chat and reactions | in step with the picture | slightly ahead of the picture | **slightly ahead of the picture** (5-10 s); reactions shown against the viewer's playback position need a timestamp in the segment |

**What the repository says about C, read 2026-10-15.**

- **The pieces exist.** Media is already sealed in independently authenticated segments (`segmented-v1`,
  `frontend/src/lib/mediaSegmented.ts`), uploaded in parts by a resumable session
  (`PUT /api/media/upload/session/:id/parts/:index`), and read while downloading
  ([media-service](../../services/media-service.md#segmented-media-play-while-downloading-canareels-r2---the-reader-release-2026-10-01),
  [media-streaming-upload](../../services/media-streaming-upload.md)). A live segment would be one
  more object of this kind, keyed by the live key rather than a per-file CEK. What is NOT there: a
  growing object (a live has no known end, while `segmented-v1` binds its last segment), and a
  manifest viewers poll.
- **Serving segments cheaply is nginx's job, not the app's.** `GET /api/media/:id` today is
  JWT-gated, `no-cache`, and streamed by media-service out of Garage on every request; only
  `/api/media/public/:id` is unauthenticated and cached a year. For C the segments of a live are
  identical for every viewer, so they can be answered by nginx without reaching media-service or the
  database: either a `proxy_cache` in **Canari's own nginx** (the frontend container,
  `infrastructure/local/Dockerfile.frontend`), or files written to a directory nginx serves with long
  cache headers. **Not in the host's nginx**: its `http` block is the DSI's shared `conf.d/`, and any
  change there needs their written agreement first ([estate-migration](../../infrastructure/estate-migration.md),
  where an nginx `proxy_cache` was already weighed and set aside for the shell). Which of the two fits
  the container is _(unverified: not tried)_. Sealed segments served without per-request auth is the
  C9 model: ciphertext readable by anyone with the URL, plaintext only by holders of the live key
  from the row.
- **That saves CPU, not bandwidth.** nginx sends one copy per viewer out of the host's uplink; an
  nginx cache is "one hop above" the origin and removes local work, not a metre of network path -
  the same reasoning estate-migration recorded for the shell.
- **A real "no cap" needs a CDN or a paid streaming product, and we have neither.** Putting a CDN in
  front of this host would need the School to delegate the `emse.fr` zone, which it refused (*"the
  School owns the zone and will not delegate it"*, estate-migration section 4). A hosted product
  (Cloudflare Stream or similar) would do B for us, but it transcodes and sees the plaintext (no E2E),
  costs per minute delivered, and is a new service for the DSI to accept _(all unverified: no price,
  no DSI answer, nothing in the repo uses it)_.
- **Playback in the WebViews** goes through Media Source Extensions in the segmented reader today
  _(unverified for a live, growing source on iOS WebKit, where MSE availability has differed from
  Chromium)_ - a WP-L1 reading on both phones, before anything else is built.
  **Read 2026-10-18 in Chrome and Safari** (not yet in the app's WebViews): a MediaRecorder fMP4
  chunk appends to a growing `MediaSource` / `ManagedMediaSource` for 36-42 min with no error
  ([bench readings](../../device-readings-calls-live-2026-10-18.md#2-live-wp-l1---capture-into-short-fmp4-segments-and-a-growing-mse-source-30-42-min)).

**Recommendation.**

- **C, and say plainly what "no cap" becomes: a cap set by the host's uplink, to be MEASURED
  (WP-L1).** Its price: **one quality, about 5-10 s behind real time, chat and reactions slightly
  ahead of the video.** C still beats A on this host: no TURN relay and no TURN budget, no per-viewer
  WebRTC peer in a media process, nginx serving files.
- **A only as an optional small-audience, low-latency mode** (a few viewers, sub-second), if the user
  wants it at all. It reuses the revived call path and nothing else needs it.
- **On quality, the answer to L8's question**: Twitch and Facebook deliver several tiers because their
  servers transcode. With C the bitrate per viewer is the broadcaster's single encode, about
  1.5-2.5 Mb/s at 720p (C3 targets 2.5 Mb/s for reels). Adaptive bitrate needs server transcoding,
  which contradicts C3 (*"il faut que la charge serveur soit minimale"*), unless the phone encodes two
  tiers itself, which doubles its uplink and its battery cost. So **one tier in v1**.

## Decisions of 2026-10-19

User calls, taken after the server half (WP-L2, WP-L3) was built. They supersede L7 and change what blocks a stable.

- **D1 - lives come BEFORE the calls revival** (supersedes L7 of 2026-10-15). WP-L0 no longer precedes the lives; calls stay dev-only (`CALLS_COMPILED = false`, [calls](calls.md)).
- **D2 - bitrate is fixed at launch by the server.** v1 picks 720p or 480p from the TOTAL live load at the moment the live starts, and never changes it mid-live. The server transcodes nothing. Mid-live adaptive bitrate is NOT v1: MediaRecorder cannot reliably change resolution or bitrate without a new init segment.
- **D3 - any member may start a live in v1, so WP-L8 is a RELEASE BLOCKER.** Moderation (hide message, remove viewer, block, report a live, staff remote cut) and the per-account limits already built must exist before any stable. Apple guideline 1.2 and the Play UGC answers (Q2) precede any store submission.
- **D4 - a "X est en live" notification**, like "X a publié", is wanted. The server half (WP-L7) is built (#2106, spaces respected like a post); a tap lands on the feed, and the client LIVE card and the live's own viewer route are owed.
- **D5 - live comments and floating reactions are wanted** (WP-L6: encrypted with the live key, ephemeral).
- **D6 - moderation works like posts.** A live is reported through the same `content_reports` path as a post ([moderation-and-blocking](../../moderation-and-blocking.md)); where a post's action is "delete the post", a live's is "cut the live" (staff remote cut, WP-L8). The broadcaster's own remove-viewer and message hiding stay. The posts moderation code is REUSED, not duplicated.

**Open question (user, 2026-10-19): "why ask the school IT department for agreement?"** Only raising the SHARED HOST's nginx connection budget (about 1500 across all the host's sites, a host-level setting owned by the school IT department) needs it, under the standing rule of CLAUDE.md. Canari's own edge container is ours. Not needed until an audience would exceed the current budget.

## The client foundation (2026-10-19)

`frontend/src/lib/live/`, shared by the viewer and the broadcaster of WP-L5. No screen, no
user-visible string.

| File | What it holds |
| --- | --- |
| `types.ts` | The wire shapes, read from `apps/social-service/src/lives/` (dates are ISO strings), every refusal `code`, and `LiveRefusalKind` - what a screen does with a refusal. |
| `api.ts` | One function per route over `apiFetch` (`startLive`, `fetchLive`, `fetchLiveManifest`, `putLiveSegment`, `endLive`, `leaveLiveSeat`, `removeLiveViewer`, `listOpenLives`, `fetchLiveLimits`), the token-free segment fetch (`fetchLiveSegment`, no custom header so no CORS preflight), and `LiveSegmentUploader`, the broadcaster's one sender: in index order, the same index retried on a transport failure, a `retry-segment` code or a `429`, stopped by any other verdict (a `410` once the server ended the live). It is the ONE index counter: the caller reads `nextIndex` BEFORE sealing (the seal binds the index), then calls `enqueue(index, sealed)`, which throws a `RangeError` unless `index === nextIndex` - a segment sealed for another index would be stored and never open for any viewer, silently. |
| `constants.ts` | The v1 capture and playback numbers from the WP-L1 bench (measured 2026-10-19, written up in draft PR #2109): 720p, 2.0 Mb/s asked, 2 s segments and keyframes, about one segment of player buffer, a 1 s manifest poll (a choice: the bench polled at 500 ms), 3.1 Mb/s per viewer for planning. Every number the SERVER enforces comes from `GET /api/lives/limits`, never from here. |
| `liveCrypto.ts` | The segment seal: `sealLiveSegment`, `openLiveSegment`, `LiveSegmentOpenError` - [the format, v1](#the-segment-seal-format-v1). |

**Every refusal is a `LiveRefusalError`** (an `ApiRefusalError`, so `refusalCode` reads it), typed at
the throw with its `kind` and the body's `viewerCap`, `nextIndex`, `endedAt`. `full` (`503 LIVE_FULL`)
is the "live complet" screen; `seats-unavailable` (`503 LIVE_SEATS_UNAVAILABLE`) is a retry, never
"complet"; `rate-limited` is any `429`, coded or nginx's. A bare `404` on `/api/lives` is `disabled`
(the `LIVE_ENABLED` guard). A transport failure is never wrapped: it stays `TransportFailureError` /
`RequestDeadlineError`.

**The segment seal is `liveCrypto.ts`** (stacked on this foundation, draft), format in the next
section. The live KEY is 32 random bytes, 64 lower-case hex, generated by the broadcaster:
`generateMediaCek()` already produces exactly that.

## The segment seal format, v1

Decided by the lead on 2026-10-19, owed an adversarial crypto review before its pull request leaves
draft. `frontend/src/lib/live/liveCrypto.ts` exports `sealLiveSegment(keyHex, liveId, index, plain)`,
`openLiveSegment(keyHex, liveId, index, sealed)` (both `Promise<Uint8Array<ArrayBuffer>>`) and
`LiveSegmentOpenError`.

| Part | v1 |
| --- | --- |
| Cipher | AES-256-GCM, 128-bit tag, the live key (the 32 bytes behind `LiveView.key`) |
| IV | 12 bytes, fresh from `crypto.getRandomValues` for every seal |
| Sealed object (concatenated) | `iv(12) + ciphertext + tag(16)` and nothing else - so at least 28 bytes |
| Plaintext | raw fMP4 bytes and nothing else: since the broadcaster (below), ONE segment = its recorder's init followed by ONE fragment ([why](#every-segment-is-self-contained)) |
| AAD (concatenated) | ASCII `canari-live-v1` + `0x00` + the live id as its 16 raw uuid bytes + the index as u32 big-endian (35 bytes) |

**Why each part.**

- **The index in the AAD** stops the storage, a cache or a path serving segment 12 as segment 5
  (reorder) or one segment twice (replay): a segment opens only at the index it was sealed for.
- **The live id in the AAD** stops a segment being replayed under another live. Distinct lives
  already have distinct keys, so this only matters if a key is ever reused - and binding the id costs
  16 bytes and makes the guarantee independent of key hygiene.
- **The version label** means a v2 changes `canari-live-v1`, so a v1 segment can never be read as a
  v2 one or the reverse: the format lives in the authenticated data, not in a byte a reader must
  remember to check.
- **No header in the plaintext.** The WP-L1 rig (`tools/live-bench/bench.js`, PR #2109) sealed a JSON
  header `{ i, recStart, segMs, mime, readyAt }`; v1 does not. The index is already the object's
  address and its AAD, the duration is `LIVE_SEGMENT_MS`, so the moment a chat line or a reaction
  (WP-L6) points at is `index x LIVE_SEGMENT_MS`, and whatever else a viewer needs comes from the
  manifest. A header is one more parser on bytes an attacker can reach, for nothing a viewer lacks.
- **No `segmented-v1` framing** (`mediaSegmented.ts`). That format splits ONE file into chunks; a
  live's segments are independent objects, each fetched, opened and discarded on its own.
- **WebCrypto, not WASM.** WASM holds the MLS group state; media content keys are SubtleCrypto
  (`$lib/mediaCrypto`), and the live key is a media key of that kind, so the media path is the
  precedent. The key is imported non-extractable for each call.
- **Random IVs under one key** are safe at this volume: a 2 s segment over the longest live the
  server allows is a few thousand seals per key, far below GCM's 2^32 random-IV bound.

**A segment that does not open is a `LiveSegmentOpenError`**, typed at the throw, `reason`
`malformed` (under 28 bytes) or `unauthentic` (GCM refused it: wrong key, live, index, version, or a
changed byte - GCM cannot tell those apart, and no caller should try). An argument no caller should
pass (a key that is not 64 hex, a live id that is not a uuid, an index outside u32) is a `RangeError`.
Nothing logs key material, plaintext or ciphertext: an index and lengths only.

Both functions copy their input SYNCHRONOUSLY, before their first `await`: the bytes read at the
call are the bytes sealed or opened, even if the caller reuses its buffer while the promise runs.

**A retry re-sends the SAME sealed bytes, never a re-seal.** `LiveSegmentUploader` keeps the sealed
object it was handed and sends it again on every retry of that index. The server's repeat of a `PUT`
for an index it already stored is idempotent only for identical bytes (same sha256); different bytes
for that index are `409 LIVE_SEGMENT_CONFLICT`, a verdict the uploader does not retry, so a re-seal
FAILS CLOSED - the queue stops and `onStopped` is told - rather than replacing a segment a viewer may
already hold. The index itself cannot drift from the one sealed: the caller seals for
`uploader.nextIndex` and `enqueue(index, sealed)` refuses any other.

**What the seal protects against, and what it does not.** social-service stores the live key in the
row and serves it as `liveKey` to every account allowed to watch, exactly like a post CEK (Q4 below,
decision C9). So the seal protects segments against the media store, the nginx cache and anyone who
holds a segment URL - NOT against social-service, which holds the key next to the manifest. It is
not end-to-end encryption against the server, and no page may call it that.

## The viewer (as built, 2026-10-19)

WP-L5's VIEWER half, **behind `LIVE_ENABLED` (`frontend/src/lib/features.ts`): on for dev builds only**,
by the same `deployEnvironment() === 'development'` test as `CALLS_ENABLED`. A production binary asks
`/api/lives` nothing and draws nothing; the server answers `404` there anyway. Not built: the
chat and reactions (WP-L6), moderation (WP-L8).

| File | What it holds |
| --- | --- |
| `lib/live/livePlayer.ts` | The MSE player and its state machine; everything outside it (API, seal, media source, timer) injected, so it is tested with fake MSE objects and a manual clock |
| `lib/live/liveViewerState.ts` | The states, and `liveFailureOutcome`: the ONE decision from a failure to a screen |
| `lib/live/fmp4Segments.ts` | The ONE fMP4 box reader of the live: `initSegmentEnd` (where a segment's `ftyp` + `moov` stop), on the same box-header reader as the [broadcaster's](#the-broadcaster-as-built) `Fmp4Splitter`, and `Fmp4ParseError` (a box it cannot frame: "Live indisponible", `playback`) |
| `lib/live/openLives.ts` | The card's list (the reader's own live left out), `formatLiveElapsed` |
| `lib/live/liveCrypto.ts` | The seal of [format v1](#the-segment-seal-format-v1); the viewer calls `openLiveSegment` and skips a segment on `LiveSegmentOpenError` |
| `components/live/` | `LiveFeedCard`, `LiveViewer`, `LiveIdentity` (who is on air: picture and name, a member or an association), `LiveBadge` |

**The card.** At the top of the feed, under the tab row, whatever the tab; hidden during a search and
when nothing is on air. It asks `GET /api/lives` when the FEED asks for its first page - the tab load
and `refreshPosts` (pull-to-refresh, retry, reconnect, a publish) bump one counter - so it has **no
timer of its own**. A lost answer keeps the rows it shows; a refusal (or the switch's `404`) removes
the card. The notification "X est en live" lands on the feed (D4), where this card is; a deep link to
one live is not built.

**The viewer** is an overlay like the reel viewer: a history entry through `bindHistoryOverlay` (Back
closes it, the feed underneath never leaves the page), `coversScreen`, `role="dialog"` named after
the broadcaster, focus on the close button, Tab kept inside (`focusTrap`) and focus back to the card's row on close, a final screen's button focused when it appears, Escape closes, no
other key is taken. The sequence is WP-L1's bench (`tools/live-bench/bench.js`):

1. A MediaSource FIRST - `MediaSource`, else `ManagedMediaSource` (the iPhone, which has no
   `MediaSource`; `disableRemotePlayback` set as it requires) - and `isTypeSupported` of
   `LIVE_RECORDER_MIME`, so an engine that cannot play never takes a seat.
2. `GET /api/lives/:id`: the key and the seat.
3. The join on the NEWEST segment alone. Every segment is SELF-CONTAINED - the recorder's init
   (`ftyp` + `moov`) then one fragment (`moof` + `mdat`), the [broadcaster's shape](#every-segment-is-self-contained) - so its
   own init is appended, then its fragment, then a seek to `end - LIVE_PLAYER_TARGET_BUFFER_MS`.
   A first segment with no init is "Live indisponible" (`playback`).
4. A poll every `LIVE_MANIFEST_POLL_MS` from `last + 1`, segments taken in order. **A segment's init
   is appended only when its bytes DIFFER from the last one appended** (a camera re-acquired
   mid-live, e.g. a rotation); an identical one is skipped. MSE allows a new initialization segment
   in the same `SourceBuffer` while the codec STRING is unchanged - resolution, SPS/PPS and audio
   configuration may change; a different codec string would need `SourceBuffer.changeType()`, which
   is not called because the recorder's type is the fixed `LIVE_RECORDER_MIME`. `mode = 'segments'`
   keeps each fragment at its own timestamps, so a re-acquire (timestamps moved FORWARD by the time
   away) opens a second buffered range: the `waiting` at the end of the first seeks across at once,
   and a drift past `LIVE_PLAYER_MAX_BEHIND_MS` does the same - one seek, never a loop.
   **The jump to the live edge**: more than `LIVE_PLAYER_CATCHUP_SEGMENTS` behind the manifest's
   `nextIndex` asks for the NEWEST window (`?from=` answers the OLDEST ten from that index) and
   takes only its newest segment; a `waiting` since the last segment seeks at the next one. Each
   poll that brings media calls `play()` if something paused the video. What was played more than
   `LIVE_PLAYER_KEEP_BEHIND_MS` ago is removed.

**Failure -> screen** (`liveFailureOutcome`, one table, tested):

| What came back | Screen |
| --- | --- |
| `full` (`503 LIVE_FULL`) | "Live complet" with "Réessayer"; no automatic retry (never hammered); no seat to give back |
| `seats-unavailable`, `rate-limited`, `unavailable` (a bare 5xx), `retry-segment`, a transport failure | "Reconnexion...", the same step again after 1 s doubling to 8 s - **never "complet"** |
| `ended` (`410`), or `not-found` once the key was served | "Le live est terminé"; no timer left. Every final screen pauses the video. The broadcaster's end deletes the row at once ([lives](../../services/lives.md#deletion-at-the-end-plus-a-sweep-q10-l3)), so a viewer polling a second later reads `404`, not `410` |
| `not-found` before the key, `removed`, `disabled`, `refused` | the neutral "Live indisponible" |
| An engine with no MSE or no `avc1`/`mp4a` support | "Live indisponible" (`unsupported`) |
| The joining segment that does not open, or three segments in a row | "Live indisponible" (`undecryptable`); one segment that does not open, or one the server no longer has (`404`), is skipped |
| Three failed appends in a row, or the `<video>`'s `error` event | "Live indisponible" (`playback`); the two failure counts are kept apart, so a segment that opens never hides an append that fails |

**"Reconnecting" for the broadcaster** is read from the manifest's `serverNow - lastSegmentAt`, BOTH the
database's clock, past `LIVE_BROADCASTER_QUIET_MS` (three segments); the end itself stays the
server's 60 s window. **The time on air** is `serverNow - startedAt` at each poll, the same clock, so
it needs no timer and never compares the device's clock with the server's.

**The seat** goes back by `DELETE /api/lives/:id/seat` when the viewer closes and on `pagehide` (best
effort: the 30 s lease is the bound); a key that arrives after a close gives its seat straight back;
a page restored from the back-forward cache starts again. **A close or a retry aborts the run's segment downloads** (`fetchLiveSegment`'s `signal`), so no fetch keeps a connection beside the next run's under nginx's per-address `limit_conn`. **Sound** is the app's one answer
(`videoSound`, `followVideoSound`): muted at every start; a `play()` refused with sound is retried
muted; the toggle unmutes with a tap.

**Logs** (`[LIVE]`): entry, every state change and decision at `debug`; refusals at `warn`; a defect
or an unopenable segment at `error`; segments SUMMARISED (one line per 30 played and at the stop),
never one line each; the key and segment bytes never.

**Verified by tests only** (`livePlayer.test.ts`, `liveViewerState.test.ts`, `fmp4Segments.test.ts`,
`openLives.test.ts`, `LiveFeedCard.svelte.test.ts`, `LiveViewer.svelte.test.ts`). **Owed on hardware**:
check Y of [device-verification](../../device-verification.md#y-watching-a-live---owed-on-both-phones-mi-9t-iphone-12),
with the [broadcaster](#the-broadcaster-as-built) on the other phone. **Known gaps:** `ManagedMediaSource`'s `endstreaming` hint is ignored
(read on the iPhone in check Y); no deep link to one live.

## The broadcaster (as built)

WP-L5's broadcaster half, built 2026-10-19 on the client foundation and the seal above, **behind
the viewer's switch, the ONE `LIVE_ENABLED`: on for dev builds only**. It turns on for production with WP-L8 (moderation, a release
blocker since any member may broadcast, D3), the device readings, and the server's switch, in one
release. **Not built: chat and reactions (WP-L6), moderation (WP-L8).**

| File | What it holds |
| --- | --- |
| `lib/live/fmp4Segments.ts` | The pure fMP4 reader: `Fmp4Splitter` turns recorder chunks into one init and its fragments (a box cut across chunks is carried), reads whether each fragment's video starts on a sync sample, `composeSegment`, and `rebaseFragment` (the media-time shift below) - and the viewer's `initSegmentEnd`, on the same box-header reader. |
| `lib/live/liveSegmentPipeline.ts` | Chunk -> fragments -> segment -> seal -> queue, ONE chunk at a time through one promise chain: the index is read from `uploader.nextIndex`, sealed for and enqueued with (no second counter). A summary line every 15 segments. |
| `lib/live/liveRecorder.ts` | `MediaRecorder` with `LIVE_RECORDER_MIME`, 2.0 Mb/s, 2 s timeslice and keyframe interval; no second container (an engine that cannot record that exact type cannot broadcast, said before Start). |
| `lib/live/liveDevice.ts` | The camera at 1280x720 + microphone (exact lens), the Screen Wake Lock, the Battery API reading. |
| `lib/live/liveBroadcast.svelte.ts` | The state machine: `preview -> starting -> live <-> away -> ending -> ended`, every dependency injected. |
| `components/live/LiveOverlay.svelte`, `LiveBroadcaster.svelte` | The full-screen layer (portal, `coversScreen`, one history entry, the edge swipe) and the broadcast screen. The viewer's identity chip is `LiveIdentity`, a different component. |

**The entry.** The post composer's chip row carries "En direct" when `LIVE_ENABLED` is on. The live
goes out under the identity chosen in the composer: the member, or an association they may post as
(`associationId`; the server checks `POST_AS_ASSO`). Never anonymous: the chip is not drawn while
"anonymous" is chosen, nor while the chosen association is missing from the list read.

**The pre-live screen is the rules, shown before EVERY live (L11)**: visible like a post by the same
identity and only while on air; reportable and cuttable by moderation; at most `maxDurationMs`; the
camera may be away at most `reconnectWindowMs` - both read from `GET /api/lives/limits`. A warning
under 60 % battery where the engine has the Battery API (Android; WebKit has none), charging or not
(WP-L1 drained ~40 %/h on a charger). Start is the acceptance; **nothing records the acceptance on
the server** (owed if L11's "accepted before a member's first live" must be provable).

### Every segment is self-contained

**ONE SEGMENT = the recorder's init (`ftyp` + `moov`, ~1.2 kB) + ONE fragment (`moof` + `mdat`,
~600-800 kB)**: 0.2 % more bytes, for three things no viewer has to work out - a join at ANY index
with no hunt for segment 0, the Android/iOS difference in the first chunk gone (Android's first chunk
is the init alone and produces no segment; iOS's is init + media), and a camera re-acquired after a
background (a new recorder, a new init) needing no signal. A chunk carrying two 2 s fragments (14 % on
Android in WP-L1) becomes TWO segments, so a segment is always about 2 s. Each fragment's keyframe
start is READ and counted (`not on keyframe` in the summary); one that does not start on a keyframe is
still sent (the ingest is gapless) and logged - WP-L1 measured none.

The [viewer](#the-viewer-as-built-2026-10-19) appends a segment's init only when it differs from the last one
appended; MSE would accept a repeated init, so that is economy, not correctness.

### Background, a lens taken, and the same live

The camera is **given back when the app is hidden, on both platforms** (the reel camera's rule), the
recorder stopped first so its last chunk still goes out. That makes WP-L1's two behaviours one path:
the Android WebView ENDED the track ~6 s after `hidden`, Safari MUTED it - neither reaches a recorder
that no longer exists. On return the server is read first (`GET /api/lives/:id`): ended (`410` /
`404`) is the end screen "stopped while the camera was paused"; any other answer, or none, re-opens
the camera and starts a NEW recorder on the SAME live - the index continues, the screen is held again.
**A new recorder restarts its media time at zero, so its fragments' `tfdt` are shifted by the time
since the first recorder started** (`rebaseFragment`): the timeline viewers append stays monotonic and
the pause is a GAP the player seeks over, never a jump back. A lens ENDED while visible (another app
took it) and a recorder `error` go `away` the same way, with a Retry. A `mute` on air is logged and
nothing else: nothing records twice.

**Each recorder's chunks are pushed with ITS pipeline generation, fixed when the recorder is
created** (`push(generation, chunk)`): the old recorder's last chunk, delivered by its `stop` after a
new generation began, still lands in the old splitter with the old init and offset. The return also
WAITS for the paused recorder's `stop` (bounded) and closes its generation before starting the next
one; a generation closed with bytes still in its splitter (a box cut short) is LOGGED as lost. A
chunk the pipeline cannot read (a Blob read that rejects) or frame breaks its generation - the
chain itself never rejects - and the pipeline TELLS the state machine (`onBroken`), which goes
`away` with the camera given back and a Retry, rather than a screen saying "on air" while nothing is
sent. **That a new recorder restarts its media time at zero is an ASSUMPTION** WP-L1 did not measure:
LIVE-B1 row 8 reads it.

### Upload health and the end

`LiveSegmentUploader` gained `onRetry(index, attempt, error)`: a retried send shows a quiet
"Reconnexion..." badge with the backlog (a plural), and the next stored segment clears it.

**The backlog is CAPPED in this layer, not the uploader's** (the queue in `api.ts` is unbounded,
~230 MB in ten minutes offline): past `ceil(reconnectWindowMs / LIVE_SEGMENT_MS)` +
`LIVE_BACKLOG_MARGIN_SEGMENTS` (5) segments waiting, the broadcast ends itself as
`connection-lost` - the server has ended a live that silent anyway, so recording on fills memory with
segments nobody can watch. The end drops the queue (`uploader.stop()`) and asks `/end` best-effort.

**The End button** (confirmed; Back and the edge swipe ask the same question) stops the recorder -
waiting for its last chunk at most `LIVE_RECORDER_STOP_BOUND_MS` (one segment + 1 s; a recorder
that never fires `stop` is logged and abandoned) - flushes the pipeline, and **gives back the camera
and the screen lock THEN**, before any network wait. What is left is the queue reaching the server,
waited for at most `reconnectWindowMs` (past it the server ended the live by absence; the unsent
queue is dropped, logged); the "ending" screen says so and offers "Quitter sans attendre", which
disposes the screen and ends the live best-effort. Then `POST /end`; a `410` from the uploader ends the screen ("the hour, or moderation") with no
end call; any other stopping refusal ends it as failed and calls `/end`; the screen unmounting or
`pagehide` ends what is on air best-effort; a killed app is the server's absence rule. A start refused
`LIVE_ALREADY_OPEN` (a previous screen killed) is not resumed: the member is told it closes within the
minute.

**What the server does not give, so the client does not show it:** a viewer count (no field in
`LiveView` or the manifest), and WHY a `410` ended a live (the body has `endedAt`, no reason - so
"the hour" and "a moderation cut" share one sentence).

**Verified by tests** (fakes for the recorder, camera, uploader and server; no clock, no sleep):
`fmp4Segments.test.ts`, `liveSegmentPipeline.test.ts`, `liveBroadcast.svelte.test.ts`,
`LiveBroadcaster.svelte.test.ts`, the composer chip in `PostComposerBar.svelte.test.ts`. **Owed on the
phones**: [LIVE-B1](../../device-verification.md#live-b1-the-broadcaster-on-both-bench-phones---owed-on-both) -
ten minutes on air watched, background and return, past the window, a network cut, the end, battery
unplugged, the screen kept on; and whether the iOS app's WKWebView honours
`videoKeyFrameIntervalDuration` (WP-L1 read Safari only).

## Open questions for the user, each with a recommendation

Answered on 2026-10-15 and moved to the decisions table: viewer cap (L8), simultaneous lives (L9),
followers (L10), safety and age (L11).

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | **Which architecture** (above)? | **C**, with A as an optional small-audience mode later. |
| Q2 | **Apple / Google policy for live UGC.** | Apple's guideline 1.2 asks UGC apps for a way to filter, report and block, and published contact info; Google Play has a UGC policy of the same kind _(both unverified against today's text - read them during WP-L0)_. L6 and L11 cover report, block and cut-off; say so in the review notes, with the video Apple asks for. |
| Q3 | **The bench, and the uplink figure.** | For C: a phone publishing segments to the LOCAL estate, read by 1 then 30 headless viewers, measuring latency, nginx CPU, the phone's uplink, battery and heat over 30-60 min. **The host's usable uplink is a separate reading, and asking the DSI for the link speed and what share Canari may use comes first** (a load test on a shared host is not ours to run unasked). Dev is no stand-in for it: `dev.canari-emse.fr` still goes through the old VM's relay and a Cloudflare tunnel. For A (if kept): the SFU with 1 then 30 subscribers, CPU/RSS and TURN bytes. |
| Q4 | **The key design** (key in the row, rotation when a viewer is removed). | A random 32-byte **live key** in the live row, served like a post CEK to any member who may watch (L2; spaces respected since 2026-10-19). It protects against the storage, a cache and the SFU, **not against a removed viewer**, who already holds it and could re-read the row. So removal is enforced **by the server** (the manifest and the key refused to that account), and rotation is NOT the mechanism: state that limit rather than rotating a key every member can fetch. |
| Q5 | **The broadcaster's network drops.** | With C, the upload is resumable: a **60 s window** _(to confirm on the bench)_ in which viewers see "reconnecting"; after it the live ends. The end is a DURABLE state on the row (`ended_at`), not a timer on the clients. |
| Q6 | **Background and screen lock on phones.** | The broadcaster's camera stops when the app leaves the foreground on both platforms _(unverified on our builds)_; treat it as a drop (Q5) and say so on screen. No background modes are added for live - they are what App Review refused once. |
| Q7 | **TURN usage.** | Only path A uses TURN (Cloudflare's TURN product; nothing on the host). If A is kept, first check that the host may reach it over UDP at all (outbound is filtered upstream), then ask the DSI for an inbound UDP range in the same request as the calls revival, so viewers reach the SFU directly and TURN relays only those who need it. |
| Q8 | **What does the broadcaster's local save record?** | Its own segments, kept on the phone and offered to the gallery at the end (the C6 save path), never the chat. Confirm. |
| Q9 | **Can a live be scheduled / shown as "upcoming"?** | Not in v1. |
| Q10 | **Live segments' retention.** | Deleted when the live ends (L3), by the same durable state, plus a sweep for any live whose `ended_at` was never written. |

## The work packages, in order

Each starts from a named point and ends on a test that would fail without it. The order assumes
Q1 = C; since 2026-10-19 WP-L0 no longer precedes the lives ([D1](#decisions-of-2026-10-19)).

| WP | What | Starting point | Done when |
| --- | --- | --- | --- |
| **WP-L0** | **Calls revival**: the five switches in one commit, the SIXTH (no names in a silent invite) and the SEVENTH (`none` level vs. a ring) decided, rung 15 CALL + CALL-13 on real hardware, the by-hand relay-path call, then **the screen recording App Review asks for**. | `frontend/src/lib/features.ts` `CALLS_ENABLED` and the switch table in [calls](calls.md) | the board rows `PASS`; the video recorded; a build accepted with calls on |
| **WP-L1** | **The C feasibility bench, before any product code**: on both phones, record 720p into short fMP4 segments for 30-60 min, seal and upload them, and play a growing source through MSE in the WebView. **And the host's usable uplink**, from the DSI's answer first (Q3), which sets the viewer cap L8 turns into. | `frontend/src/lib/mediaSegmented.ts`, the camera of [reels](reels.md), the segmented reader | latency, phone uplink, battery and heat measured on Mi 9T and iPhone 12, and the host's usable uplink, written here; or a refutation of C |
| **WP-L2** (**built 2026-10-18, server only, [lives](../../services/lives.md)**) | **The live row and its key**: a `lives` record (broadcaster, as-association, key, `started_at`, `ended_at`), removed-viewer list, the end as durable state. | social-service posts / reels server ([reels (server)](../../services/reels.md)) | API tests: key served as a post CEK to members; refused to a removed viewer; nothing after `ended_at` |
| **WP-L3** (**built 2026-10-18, server only, [lives](../../services/lives.md)**) | **Segment ingest and the manifest**: a growing sealed object or one object per segment, a manifest viewers poll, deletion at `ended_at` plus a sweep (Q10). | the upload session ([media-streaming-upload](../../services/media-streaming-upload.md)) | specs: a segment out of order is refused; the manifest stops at `ended_at`; everything is gone after the sweep |
| **WP-L4** (**built 2026-10-19, server and nginx, [lives](../../services/lives.md#serving-a-segment-from-the-nginx-cache-wp-l4); cap 24 viewers from the measured ~90 Mb/s, [viewer cap](../../services/lives.md#the-viewer-cap-wp-l4)**) | **Segments served by nginx**: an unauthenticated route for sealed live segments answered by Canari's own nginx (cache or static files), never reaching media-service or the database; the per-host viewer cap from WP-L1's uplink figure, refused with a clear "live full" screen. | `infrastructure/local/Dockerfile.frontend` (Canari's nginx), `GET /api/media/public/:id` as the model | a second viewer's fetch is served without a media-service log line; viewer N+1 past the cap is refused |
| **WP-L5** (**viewer and broadcaster built 2026-10-19 behind `LIVE_ENABLED`, dev builds only, [viewer](#the-viewer-as-built-2026-10-19), [broadcaster](#the-broadcaster-as-built); the phone readings are owed**) | **Broadcaster and viewer UI**: composer "Live" entry, broadcast screen, viewer screen, reconnect state (Q5), first-live rules (L11). | the composer ([posts](posts.md)) and camera ([reels](reels.md)) | e2e on two browser contexts; phone readings on Mi 9T and iPhone 12 |
| **WP-L6** | **Live comments and floating reactions ARE wanted (user, 2026-10-19, D5)**, encrypted with the live key, ephemeral. | the WS gateway ([chat-gateway](../../services/chat-gateway.md)) | tests: messages unreadable without the key; nothing persisted after `ended_at` |
| **WP-L7** (**server half built 2026-10-19, [lives](../../services/lives.md#the-push-to-the-followers-wp-l7-server-half); a tap lands on the feed (`appRouteForDeepLink` owns the `live` host), where the LIVE card is (dev builds only, [viewer](#the-viewer-as-built-2026-10-19)); the live's own viewer route is still owed**) | **Announcement**: LIVE card at the top of the feed; push to followers (L10), sent at the first stored segment. | the feed, `PostNotificationsService` | tests on the follower set incl. mutes; one push per live, never on reconnect |
| **WP-L8** (**RELEASE BLOCKER before any stable, D3; moderation works like posts, D6: reuse the posts code path, no parallel mechanism**) | **Moderation**: hide message, remove viewer, block, report a live through `content_reports` like a post, staff remote cut (the live equivalent of "delete the post"). | `content_reports`, [moderation-and-blocking](../../moderation-and-blocking.md) | tests: a cut ends the live and the row; a report reaches staff while live |
| **WP-L9** (Q2 answers precede any store submission, D3) | **Store review**: UGC answers (Q2), the review video for live, then a pre-release to testers. | [mobile](../mobile.md) submission notes | accepted builds on both stores |
| **WP-L10** (only if A is kept) | **Low-latency small-audience mode on the SFU**: a `broadcast` room kind (broadcaster-only publish, receive-only viewers, a cap, a server-side kick), frame E2E keyed by the live key with **no cleartext path**, the SFU bench with 1 then 30 subscribers. | `apps/call-service/src/main.rs` `on_track`, `tests/relay_path.rs`, `CallService.ts` `setupEncryption` | Rust tests: a viewer's track is refused, a kicked peer cannot rejoin; a missing transform refuses to broadcast; TURN GB per live-hour measured |

## See also

- [lives](../../services/lives.md) - the server half as built (WP-L2, WP-L3, WP-L7's push), and its switch

- [calls](calls.md) - the switches and why calls are held off
- [call-service](../../services/call-service.md) - the SFU
- [reels](reels.md) - the chantier this is stage R4 of
- [backlog](../../backlog.md) - the calls-held-off items
