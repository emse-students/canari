# Live - the plan (R4 / decision C9, not started)

A member opens the composer, picks **Live**, and the whole Canari network can watch until the
broadcast ends - Facebook-style. This page is the PLAN: what the user decided on 2026-10-15, what the
existing calling bricks really are (read from the code that day), the questions still open for the
user, and the work packages in order. Nothing of it is built. It is stage R4 of the CanaReels chantier
([reels C9](reels.md#the-chantier-the-comparison-the-ten-decisions-the-build-order-user-2026-09-29)),
and it sits behind the calls revival ([calls](calls.md)).

**Convention on this page: a claim not read in this repository's code or measured is marked
_(unverified)_.** Store policy text, Cloudflare pricing and the host's link speed are among them.

## What the user decided (2026-10-15)

| # | Question | The user's answer |
| --- | --- | --- |
| L1 | Who may start a live? | **Any member.** |
| L2 | Who may watch? | **The whole Canari network** - C9: the live's key travels in the row, as a post CEK does. |
| L3 | Is a live kept afterwards? | **No replay: a live disappears when it ends.** The broadcaster may save it locally on their own device. |
| L4 | What does the first version carry? | **A short live with a small audience** - tens of viewers, 30 to 60 minutes at most - with an **ephemeral live chat and floating reactions**; the chat is **encrypted with the live's key**. The audience size is superseded by L8 (no cap). |
| L5 | How is a live announced? | **A LIVE card at the top of the feed for everyone**, plus a **push ONLY to the followers** of the member or association broadcasting. |
| L6 | How is a live moderated? | **The broadcaster hides chat messages and removes viewers; any viewer can report; staff can cut a live remotely.** |
| L7 | In what order? | **Revive calls first, then live.** The user added that what mostly blocked calls is that **Apple App Review needs a VIDEO recording showing everything works** (still to do), on top of our own tests. |
| L8 | Is there a viewer cap? | **No cap** - *"pas de plafond, mais la qualité du live ne sera pas si grande si ? quelle techno utilisent Twitch ou Facebook ?"*. **This CONFLICTS with the code as it stands**: the SFU path is relay-only through Cloudflare TURN, one stream per viewer, against a ~950 GB monthly budget ([below](#what-exists-read-from-the-code-on-2026-10-15)). It is what forces the [architecture choice](#architecture-options-for-an-uncapped-audience). |
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
| TURN | **Both ends are relay-only**: the client sets `iceTransportPolicy: 'relay'`, the SFU selects `RTCIceTransportPolicy::Relay` when a TURN server is configured. So **every media byte, broadcaster in and each viewer out, crosses Cloudflare TURN** - viewers do not pull from the SFU directly. | `CallService.ts`, `main.rs` `create_peer_connection` |
| TURN budget | chat-delivery refuses new credentials once a monthly counter reaches `CLOUDFLARE_TURN_MONTHLY_BUDGET_GB` (default 950, "Cloudflare free tier is ~1000 GB" per its comment, _(unverified)_ against Cloudflare's current terms). | `apps/chat-delivery-service/src/services/calls.service.ts` |
| Inbound UDP on the host | Not requested: TURN/UDP to the Portail-etu host "goes in its own request when calls are revived". Until then the SFU's only path is through Cloudflare TURN. | [estate-migration](../../infrastructure/estate-migration.md) |
| Host capacity | 4 vCPU, 11 G RAM shared with prod, dev, Le Cercle and Authentik. **The link speed and any egress cap are not documented anywhere** _(unverified)_. | [estate-migration](../../infrastructure/estate-migration.md), [storage-and-retention](../../infrastructure/storage-and-retention.md) |
| Followers | Both relations exist: `user_follows` and `association_follows`, plus `association_push_mutes`. | `apps/social-service/src/follows/entities/` |
| Reports | `content_reports` (social-service) is the only report store. | [moderation-and-blocking](../../moderation-and-blocking.md) |
| State of calls | `CALLS_ENABLED = false` since 0.14.15; five switches move together; the SFU has never placed a real call; webrtc 0.20 is a port, not a bump. | [calls](calls.md) |

**The egress arithmetic, which is an ESTIMATE until a bench measures it (path A, WP-L10).** The ~1.5 Mb/s per viewer of
C9 is a planning figure, not a measurement. At that rate, 30 viewers for 60 minutes is
45 Mb/s x 3600 s = about **20 GB through TURN per live-hour**, plus the broadcaster's uplink - so
the default 950 GB budget is roughly **45 such lives a month**, shared with every call. Whether
Cloudflare counts the SFU-to-TURN leg and the TURN-to-viewer leg separately is _(unverified)_.

## Architecture options for an uncapped audience

L8 (no viewer cap) and L9 (no cap on simultaneous lives) cannot be met by the call path as it is
built. Three shapes, compared honestly.

| | A - WebRTC through our SFU | B - what Twitch and Facebook do | C - B without server transcoding (Canari variant) |
| --- | --- | --- | --- |
| Ingest | WebRTC to `call-service` | RTMP or WebRTC (WHIP) to an ingest server _(unverified: public descriptions, not read)_ | the broadcaster's phone encodes ONE quality (720p, as C3 for reels) into short fMP4 segments, seals each with the live key, uploads them like encrypted media parts |
| Server work | forwards every packet to every viewer | **transcodes** into several qualities, packages HLS/DASH | **stores only** - no transcoding, consistent with C3 |
| Delivery | one stream per viewer, relay-only through Cloudflare TURN (verified above) | identical cacheable segments through a CDN | identical sealed segments, meant to be served through the Cloudflare cache |
| Latency | sub-second | ~2-6 s with low-latency HLS, more with classic HLS _(unverified)_ | **~5-10 s** _(estimate: segment length + upload + polling; to be measured)_ |
| Quality | one bitrate for all (no simulcast) | adaptive bitrate, several tiers | **one quality for all**; a viewer on a weak network stalls or buffers rather than dropping to a lower tier |
| Cost per extra viewer | a full stream through our box AND through TURN, ~1.5 Mb/s, against a ~950 GB/month budget shared with calls | a CDN hit | an edge-cache hit; the origin serves each segment roughly once per edge location _(unverified: Cloudflare's tiered caching behaviour, not measured here)_ |
| Scales to | **tens** of viewers | very large audiences | the whole network, bounded by the broadcaster's uplink, not by the audience |
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
- **The Cloudflare cache does NOT cover these routes today.** The Cache Rules cache `/_app/immutable/*`
  and everything outside `/api/` and `/internal/` that sends a `Cache-Control`
  ([cloudflare-edge](../../infrastructure/cloudflare-edge.md#the-shell-is-cached-at-the-edge-and-nowhere-else-and-the-deploy-says-when-it-expired)).
  `GET /api/media/:id` is under `/api/`, JWT-gated and `no-cache`; only `/api/media/public/:id` is
  served without auth and cached a year. **So C needs a new route and a Cache Rule** (a one-off the
  user does in the dashboard): sealed segments served without per-request auth, which is the C9 model
  - ciphertext readable by anyone with the URL, plaintext only by holders of the live key from the row.
  Whether caching such objects is within Cloudflare's terms for the plan in use is _(unverified)_.
- **Playback in the WebViews** goes through Media Source Extensions in the segmented reader today
  _(unverified for a live, growing source on iOS WebKit, where MSE availability has differed from
  Chromium)_ - a WP-L1 reading on both phones, before anything else is built.
- **Cloudflare Stream, or any hosted live product**, would do B for us, but it transcodes and sees
  the plaintext (no E2E), costs per minute delivered, and is a new service for the DSI to accept _(all
  unverified: no price, no DSI answer, nothing in the repo uses it)_.
- **The origin is the shared host**, reached through the Cloudflare tunnel; its link speed is
  undocumented _(unverified)_. With C it serves each segment roughly once per edge location rather
  than once per viewer.

**Recommendation.**

- **C for "no cap"**, and say its price plainly: **one quality, about 5-10 s behind real time, chat
  and reactions slightly ahead of the video.**
- **A only as an optional small-audience, low-latency mode** (a few viewers, sub-second), if the user
  wants it at all. It reuses the revived call path and nothing else needs it.
- **On quality, the answer to L8's question**: Twitch and Facebook deliver several tiers because their
  servers transcode. With C the bitrate per viewer is the broadcaster's single encode, about
  1.5-2.5 Mb/s at 720p (C3 targets 2.5 Mb/s for reels). Adaptive bitrate needs server transcoding,
  which contradicts C3 (*"il faut que la charge serveur soit minimale"*), unless the phone encodes two
  tiers itself, which doubles its uplink and its battery cost. So **one tier in v1**.

## Open questions for the user, each with a recommendation

Answered on 2026-10-15 and moved to the decisions table: viewer cap (L8), simultaneous lives (L9),
followers (L10), safety and age (L11).

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | **Which architecture** (above)? | **C**, with A as an optional small-audience mode later. |
| Q2 | **Apple / Google policy for live UGC.** | Apple's guideline 1.2 asks UGC apps for a way to filter, report and block, and published contact info; Google Play has a UGC policy of the same kind _(both unverified against today's text - read them during WP-L0)_. L6 and L11 cover report, block and cut-off; say so in the review notes, with the video Apple asks for. |
| Q3 | **The bench.** | For C: a phone publishing segments to the LOCAL estate, read by 1 then 30 headless viewers, then on **dev**, never prod: measure latency, the origin's bytes against the edge's, the phone's uplink, battery and heat over 30-60 min. For A (if kept): the SFU with 1 then 30 subscribers, CPU/RSS and TURN bytes. |
| Q4 | **The key design** (key in the row, rotation when a viewer is removed). | A random 32-byte **live key** in the live row, served like a post CEK to any member (L2). It protects against the storage, the CDN and the SFU, **not against a removed viewer**, who already holds it and could re-read the row. So removal is enforced **by the server** (the manifest and the key refused to that account), and rotation is NOT the mechanism: state that limit rather than rotating a key every member can fetch. |
| Q5 | **The broadcaster's network drops.** | With C, the upload is resumable: a **60 s window** _(to confirm on the bench)_ in which viewers see "reconnecting"; after it the live ends. The end is a DURABLE state on the row (`ended_at`), not a timer on the clients. |
| Q6 | **Background and screen lock on phones.** | The broadcaster's camera stops when the app leaves the foreground on both platforms _(unverified on our builds)_; treat it as a drop (Q5) and say so on screen. No background modes are added for live - they are what App Review refused once. |
| Q7 | **TURN usage.** | Only path A uses TURN. If A is kept, ask the DSI for an inbound UDP range in the same request as the calls revival, so viewers reach the SFU directly and TURN relays only those who need it. |
| Q8 | **What does the broadcaster's local save record?** | Its own segments, kept on the phone and offered to the gallery at the end (the C6 save path), never the chat. Confirm. |
| Q9 | **Can a live be scheduled / shown as "upcoming"?** | Not in v1. |
| Q10 | **Live segments' retention.** | Deleted when the live ends (L3), by the same durable state, plus a sweep for any live whose `ended_at` was never written. |

## The work packages, in order

Each starts from a named point and ends on a test that would fail without it. The order assumes
Q1 = C; WP-L0 stays first by the user's decision (L7).

| WP | What | Starting point | Done when |
| --- | --- | --- | --- |
| **WP-L0** | **Calls revival**: the five switches in one commit, the SIXTH (no names in a silent invite) and the SEVENTH (`none` level vs. a ring) decided, rung 15 CALL + CALL-13 on real hardware, the by-hand relay-path call, then **the screen recording App Review asks for**. | `frontend/src/lib/features.ts` `CALLS_ENABLED` and the switch table in [calls](calls.md) | the board rows `PASS`; the video recorded; a build accepted with calls on |
| **WP-L1** | **The C feasibility bench, before any product code**: on both phones, record 720p into short fMP4 segments for 30-60 min, seal and upload them, and play a growing source through MSE in the WebView. | `frontend/src/lib/mediaSegmented.ts`, the camera of [reels](reels.md), the segmented reader | latency, uplink, battery and heat measured on Mi 9T and iPhone 12 and written here; or a refutation of C |
| **WP-L2** | **The live row and its key**: a `lives` record (broadcaster, as-association, key, `started_at`, `ended_at`), removed-viewer list, the end as durable state. | social-service posts / reels server ([reels (server)](../../services/reels.md)) | API tests: key served as a post CEK to members; refused to a removed viewer; nothing after `ended_at` |
| **WP-L3** | **Segment ingest and the manifest**: a growing sealed object or one object per segment, a manifest viewers poll, deletion at `ended_at` plus a sweep (Q10). | the upload session ([media-streaming-upload](../../services/media-streaming-upload.md)) | specs: a segment out of order is refused; the manifest stops at `ended_at`; everything is gone after the sweep |
| **WP-L4** | **The cacheable route and the Cache Rule** (the rule is a one-off for the user in the Cloudflare dashboard). | [cloudflare-edge](../../infrastructure/cloudflare-edge.md) Cache Rules, `GET /api/media/public/:id` as the model | `cf-cache-status: HIT` on a second viewer's fetch, measured through the edge on dev |
| **WP-L5** | **Broadcaster and viewer UI**: composer "Live" entry, broadcast screen, viewer screen, reconnect state (Q5), first-live rules (L11). | the composer ([posts](posts.md)) and camera ([reels](reels.md)) | e2e on two browser contexts; phone readings on Mi 9T and iPhone 12 |
| **WP-L6** | **Live chat and floating reactions**, encrypted with the live key, ephemeral. | the WS gateway ([chat-gateway](../../services/chat-gateway.md)) | tests: messages unreadable without the key; nothing persisted after `ended_at` |
| **WP-L7** | **Announcement**: LIVE card at the top of the feed; push to followers (L10). | the feed, `PostNotificationsService` | tests on the follower set incl. mutes; one push per live, never on reconnect |
| **WP-L8** | **Moderation**: hide message, remove viewer, block, report a live, staff remote cut. | `content_reports`, [moderation-and-blocking](../../moderation-and-blocking.md) | tests: a cut ends the live and the row; a report reaches staff while live |
| **WP-L9** | **Store review**: UGC answers (Q2), the review video for live, then a pre-release to testers. | [mobile](../mobile.md) submission notes | accepted builds on both stores |
| **WP-L10** (only if A is kept) | **Low-latency small-audience mode on the SFU**: a `broadcast` room kind (broadcaster-only publish, receive-only viewers, a cap, a server-side kick), frame E2E keyed by the live key with **no cleartext path**, the SFU bench with 1 then 30 subscribers. | `apps/call-service/src/main.rs` `on_track`, `tests/relay_path.rs`, `CallService.ts` `setupEncryption` | Rust tests: a viewer's track is refused, a kicked peer cannot rejoin; a missing transform refuses to broadcast; TURN GB per live-hour measured |

## See also

- [calls](calls.md) - the switches and why calls are held off
- [call-service](../../services/call-service.md) - the SFU
- [reels](reels.md) - the chantier this is stage R4 of
- [backlog](../../backlog.md) - the calls-held-off items
