# Live - the plan (R4 / decision C9; the server half WP-L2/L3 built 2026-10-18, the WP-L1 bench measured 2026-10-19, WP-L7's push, the WP-L5 viewer and broadcaster behind a dev-only switch and WP-L8's server half 2026-10-19; compiled into every build since the production flip of 2026-10-30)

> **Turning lives on in production** - the flip (2026-10-30: both deploy-time locks open, `lives_mode` the runtime switch), the gates, the readings still owed, the viewer-cap ladder and the owner's points on the lives terms and privacy text: [live-production](live-production.md), the only copy.
>
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
| L4 | What does the first version carry? | **A short live with a small audience** - tens of viewers, 30 to 60 minutes at most - with an **ephemeral live chat and floating reactions**; the chat is **encrypted with the live's key**. The audience size is superseded by L8 (no cap). **NO DURATION CAP (owner, 2026-10-31):** a live lasts as long as its broadcaster sends; the 60-minute cap and the byte budget derived from it are removed (server, client, sheet), and the server TRIMS the segments behind the newest 20 while the live runs, so what a live stores is at most 20 x 4 MiB whatever its duration ([lives](../../services/lives.md#what-one-broadcaster-may-store)). "30 to 60 minutes" above is a planning figure, no longer a limit. |
| L5 | How is a live announced? | **A LIVE card at the top of the feed for everyone**, plus a **push ONLY to the followers** of the member or association broadcasting. |
| L6 | How is a live moderated? | **The broadcaster hides chat messages and removes viewers; any viewer can report; staff can cut a live remotely.** |
| L7 | In what order? | **SUPERSEDED 2026-10-19 by [D1](#decisions-of-2026-10-19): lives come BEFORE the calls revival.** Was: revive calls first, then live. The user added that what mostly blocked calls is that **Apple App Review needs a VIDEO recording showing everything works** (still to do), on top of our own tests. |
| L8 | Is there a viewer cap? | **No cap, CONFIRMED again 2026-10-20 ("Je ne veux pas de plafond"); the plan is [below](#uncapped-audience---the-plan-2026-10-20)** and the cap of 24 stays in code until it is measured. **No cap** - *"pas de plafond, mais la qualité du live ne sera pas si grande si ? quelle techno utilisent Twitch ou Facebook ?"*. **This CONFLICTS with what exists**: the call path sends one stream per viewer through Cloudflare TURN against a ~950 GB monthly budget ([below](#what-exists-read-from-the-code-on-2026-10-15)), and any other path still leaves through the host's own uplink, which is unknown and shared with the DSI. It is what forces the [architecture choice](#architecture-options-for-an-uncapped-audience), and the honest answer is **a cap set by the host's uplink, to be MEASURED**. |
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
| Frame E2E | `CallService.ts` derives one key per direction with `mlsService.exportSecret(groupId, 'mls-webrtc-media-v2', '<callId>|<sender role>', 32)` (`utils/callKeys.ts`) and applies AES-GCM in a worker through `RTCRtpScriptTransform` (or `createEncodedStreams`). **An MLS exporter needs an MLS group, and the network is not one**, so a live needs a different key source (L2: the key in the row). | `frontend/src/lib/services/CallService.ts` `setupEncryption`, `workers/encryption.worker.ts` |
| A silent cleartext path | When `RTCRtpScriptTransform` is missing or `VITE_CALL_E2E_ENCRYPTION=false`, the client logs and sends media **unencrypted** through the SFU. Under the project's no-fallback rule this must not carry over to live: no transform, no broadcast. | `CallService.ts` `attachMediaTransforms` |
| TURN provider | **Cloudflare TURN (the Calls/Realtime TURN service), a SaaS reached by API**, not the Cloudflare proxy: both `call-service` and chat-delivery mint credentials at `https://rtc.live.cloudflare.com/v1/turn/keys/{id}/credentials/generate-ice-servers`, and the production compose passes `CLOUDFLARE_CALLS_API_TOKEN` / `CLOUDFLARE_TURN_KEY_ID` to both. **No TURN server runs on the host** (`coturn` is in the LOCAL compose only). Whether the production secrets are set today is _(unverified: read from the compose, not the box)_. | `main.rs` `fetch_cloudflare_ice_servers`, `calls.service.ts`, `infrastructure/docker-compose.prod.yml` |
| TURN path | **Both ends are relay-only**: the client sets `iceTransportPolicy: 'relay'`, the SFU selects `RTCIceTransportPolicy::Relay` when a TURN server is configured. So **every media byte, broadcaster in and each viewer out, crosses Cloudflare TURN** - viewers do not pull from the SFU directly. Whether the host may reach Cloudflare TURN over UDP at all is _(unverified)_: its outbound traffic is filtered upstream (TCP 7844 to Cloudflare was found blocked, [estate-migration](../../infrastructure/estate-migration.md)). | `CallService.ts`, `main.rs` `create_peer_connection` |
| TURN budget | chat-delivery refuses new credentials once a monthly counter reaches `CLOUDFLARE_TURN_MONTHLY_BUDGET_GB` (default 950, "Cloudflare free tier is ~1000 GB" per its comment, _(unverified)_ against Cloudflare's current terms). It concerns the TURN product only, so **it binds option A alone**. | `apps/chat-delivery-service/src/services/calls.service.ts` |
| Inbound UDP on the host | Not requested: TURN/UDP to the Portail-etu host "goes in its own request when calls are revived". | [estate-migration](../../infrastructure/estate-migration.md) |
| Host capacity | 4 vCPU, 11 G RAM shared with prod, dev, Le Cercle, Authentik and the DSI's co-tenant sites. **The uplink speed and any egress cap are not documented anywhere** _(unverified)_. | [estate-migration](../../infrastructure/estate-migration.md), [storage-and-retention](../../infrastructure/storage-and-retention.md) |
| Followers | Both relations exist: `user_follows` and `association_follows`, plus `association_push_mutes`. | `apps/social-service/src/follows/entities/` |
| Reports | `content_reports` (social-service) is the only report store. | [moderation-and-blocking](../../moderation-and-blocking.md) |
| State of calls | `CALLS_ENABLED = false` since 0.14.15; the switches move in two groups since 2026-10-21 (`CALLS_COMPILED` for in-app calls, `CALLS_NATIVE_RING_COMPILED` for the native ring, which the first production calls ship without); the SFU has never placed a real call; webrtc 0.20 is a port, not a bump. | [calls](calls.md) |

**The egress arithmetic.** The ~1.5 Mb/s per viewer
of C9 was a planning figure; **WP-L1 measured ~3.1 Mb/s from an Android broadcaster and ~2.3 Mb/s from an iPhone** ([below](#wp-l1---measured-2026-10-19)), so use 3.1. Whatever the path, **the host sends one copy per
viewer**:

```
egress(Mb/s) = viewers x bitrate(Mb/s)          (summed over simultaneous lives)
max viewers  = usable uplink(Mb/s) / bitrate     usable = the share of the host's link left to Canari
```

At 3.1 Mb/s (720p from the Mi 9T, measured), 100 Mb/s of usable uplink is 32 viewers and 1 Gb/s is 322 - **and the
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
| Latency | sub-second | ~2-6 s with low-latency HLS, more with classic HLS _(unverified)_ | **5.8-7.3 s glass-to-glass, p50, measured on dev** with 2 s segments ([WP-L1](#wp-l1---measured-2026-10-19)) |
| Quality | one bitrate for all (no simulcast) | adaptive bitrate, several tiers | **one quality for all**; a viewer on a weak network stalls or buffers rather than dropping to a lower tier |
| Cost per extra viewer | a WebRTC peer connection in the SFU process, plus a full stream through the host AND through TURN (~950 GB/month shared with calls) | a CDN hit | one file read answered by nginx (no app, no database, no media process) - but still **one copy out of the host's uplink** |
| Scales to | **tens** of viewers | very large audiences | **uplink / bitrate** viewers (formula above), unknown until measured; not the whole network |
| Chat and reactions | in step with the picture | slightly ahead of the picture | **slightly ahead of the picture** (6-7 s measured); reactions shown against the viewer's playback position need a timestamp in the segment |

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
- **Playback in the WebViews** goes through Media Source Extensions in the segmented reader today.
  **Read 2026-10-18 in Chrome and Safari**: a MediaRecorder fMP4 chunk appends to a growing
  `MediaSource` / `ManagedMediaSource` for 36-42 min with no error
  ([bench readings](../../device-readings-calls-live-2026-10-18.md#2-live-wp-l1---capture-into-short-fmp4-segments-and-a-growing-mse-source-30-42-min)).
  **Read 2026-10-19 through the dev ingest**, in the Android app's WebView and in iOS Safari, as
  broadcaster and viewer: 0 append errors, 0 refusals ([WP-L1](#wp-l1---measured-2026-10-19)).

**Recommendation.**

- **C, and say plainly what "no cap" becomes: a cap set by the host's uplink, to be MEASURED
  (WP-L1).** Its price: **one quality, about 6-7 s behind real time (measured), chat and reactions slightly
  ahead of the video.** C still beats A on this host: no TURN relay and no TURN budget, no per-viewer
  WebRTC peer in a media process, nginx serving files.
- **A only as an optional small-audience, low-latency mode** (a few viewers, sub-second), if the user
  wants it at all. It reuses the revived call path and nothing else needs it.
- **On quality, the answer to L8's question**: Twitch and Facebook deliver several tiers because their
  servers transcode. With C the bitrate per viewer is the broadcaster's single encode, **measured
  at 3.1 Mb/s (Mi 9T) and 2.3 Mb/s (iPhone 12) at 720p** ([WP-L1](#wp-l1---measured-2026-10-19)). Adaptive bitrate needs server transcoding,
  which contradicts C3 (*"il faut que la charge serveur soit minimale"*), unless the phone encodes two
  tiers itself, which doubles its uplink and its battery cost. So **one tier in v1**.

## WP-L1 - measured (2026-10-19)

**The transport works end to end, in the Android app's own WebView, on the dev ingest built by
WP-L2/L3, with both phone engines as broadcaster and as viewer.** Nothing in it refutes C. The
latency is **about 6-7 s glass-to-glass**, the upload costs a fraction of a segment's duration on
Wi-Fi, and the two real costs are the Android broadcaster's battery and what the app does when it
leaves the foreground. The 2026-10-18 capture-only readings (no upload, in Chrome and Safari) are on
[device-readings-calls-live-2026-10-18](../../device-readings-calls-live-2026-10-18.md#2-live-wp-l1---capture-into-short-fmp4-segments-and-a-growing-mse-source-30-42-min);
this section adds the network half and the in-app engine.

**The rig** ([`tools/live-bench/`](../../../../tools/live-bench/README.md), throwaway, not shipped): a
script evaluated in an inspectable page records with `MediaRecorder` (H.264 + AAC fMP4, a timeslice
equal to the segment length, `videoKeyFrameIntervalDuration` the same), seals each chunk with
AES-GCM-256, and `PUT`s it to `/api/lives/:id/segments/:i` on `dev.canari-emse.fr` (`LIVE_ENABLED`
is on there). Viewers poll the manifest every 500 ms, `GET` each new segment from media-service,
open it and append it to `MediaSource` / `ManagedMediaSource`, joining at the newest segment. Every
page syncs its clock to the manifest's `serverNow` (min-RTT, error under 90 ms), so
**glass-to-glass = now - (recorder start + the media time on screen)**, across devices. Pages:

- **Mi 9T, the Canari app** (`fr.emse.canari` 1.3.0 tester build, Android System WebView 152): its
  WebView is inspectable and the app talks to dev. Uploads went through the app's own Tauri HTTP
  `fetch`, as product code would.
- **iPhone 12, Safari** (iOS 27.0.1), signed in to dev with a test account: the TestFlight
  WKWebView is NOT inspectable, so iOS is Safari's WebKit, not the app's.
- **PC, Chrome** on dev (a third viewer on a wired link).

All on Wi-Fi, both phones on USB power. Runs: **A** Mi 9T broadcasting, 21.8 min clean then a
background test; **B** iPhone broadcasting, 22.2 min clean then a background test (36.5 min in all);
**C** four 4-5 min variants from the Mi 9T (1 s and 4 s segments, 480p, 720p at a lower target).

### The broadcaster

| Reading | Mi 9T, app WebView (run A) | iPhone 12, Safari (run B) |
| --- | --- | --- |
| Capture | 720x1280 portrait, 30 fps, `video/mp4;codecs=avc1.42E01F,mp4a.40.2` | 1280x720 landscape, 30 fps, the same string |
| Bitrate for a 2.5 Mb/s target | **3.08 Mb/s mean**; every 2 s fragment 3.11 p50, 3.76 max | **2.32 Mb/s mean**; 2.35 p50, 2.64 max per segment |
| Encoder floor (run C) | a **1.5 Mb/s** target at 720p gives **2.60 Mb/s**; **480p** (480x854) at 1.2 Mb/s gives **2.59 Mb/s** - the Android encoder does not go lower with 2 s keyframes, whatever the size | not measured |
| Segment size (2 s) | 780 kB p50, 1 583 kB max (a merged pair, below) | 587 kB p50, 661 kB max |
| Segment cadence | 2.03 s p50 but **82 of 567 chunks (14 %) carry TWO 2 s fragments** at once (4.0 s) | 2.029 s p50, 2.056 s max - regular |
| Segment structure | segment 0 is the **init alone** (`ftyp,moov`, 1.2 kB); 567/567 media segments box-aligned and **starting on a keyframe** | segment 0 is **init + first media**; 657/657 box-aligned, starting on a keyframe |
| Seal (AES-GCM per segment) | 5.3 ms p50, 19 ms p90, 40 ms max | 2.0 ms p50, 25 ms max |
| Upload (`PUT`, ready -> stored) | **650 ms p50**, 1.05 s p90 (10.3 Mb/s); one Wi-Fi hiccup of 22.6 s left a 14-segment backlog that drained by itself | **286 ms p50**, 434 ms p90 (17 Mb/s) |
| Refusals by the ingest | 0 in 567 (no 409, 413, 429, 503) | 0 in 1 070 |
| Battery, on USB (a 400 mA port) | **100 -> 88 % in 17.8 min, ~40 %/h DRAINED while plugged**; battery 30.6 -> 38.1 C; thermal status 0 throughout | not readable: at 100 % on the charger |
| App to the background for 20 s | the camera track **ENDS** 5.9 s after `hidden` (no `mute`), and stays ended on return: capture is dead until a new `getUserMedia`. The Tauri `fetch` fails (`TransportFailureError`) while hidden. The live then **ended itself 77 s after its last stored segment** (the 60 s window plus the 30 s sweep), viewers got `410` | the track **mutes** at once and **unmutes** on return; capture resumed, a 22 s gap, the live survived (under 60 s) |

### The viewers

| Reading | iPhone Safari watching the Mi 9T (A) | Mi 9T app watching the iPhone (B) | PC Chrome (A / B) |
| --- | --- | --- | --- |
| Engine | `ManagedMediaSource`, `isTypeSupported` true, appends 0 errors | `MediaSource`, 0 append errors | `MediaSource` |
| Join | init, then the newest segment, seek to its end - 0 failures | same | same |
| Recorder handover -> playable here | 1.9 s p50, 3.0 s p90 | 1.9 s p50, 2.2 s p90 | 1.9 / 1.7 s p50 |
| Segment `GET` | 0.94 s p50 (780 kB) | 1.26 s p50 (587 kB) | 0.97 / 1.14 s p50 |
| **Glass-to-glass** | **7.3 s p50, 7.5 s p90** | **5.8 s p50, 5.9 s p90** | 7.3 / 6.2 s p50 |
| Stalled | 3.2 % of the time (23 stalls in 19 min) | **0 stalls in 21 min** | 4.8 % / 0.2 % |
| Dropped frames | 1 of 33 828 | 123 of 37 904 | 860 of 31 765 / 123 of 37 997 |

**Where the 6-7 s goes** (run B, the regular encoder): the segment's own 2 s; the upload, 0.3 s;
half a poll, 0.25 s; the `GET`, 1.2 s; and the player sitting **3.0 s behind its buffer's end**
(p50). Run A is a second worse because one Android chunk in seven is 4 s long. The download leg is
the dev path's: a segment `GET` is TTFB 0.10 s then 1.1 s of transfer (~4.2 Mb/s, HTTP/3), the
manifest 0.10 s, and a 2.1 MB static asset from nginx over the same path reads at ~7.9 Mb/s - so the
`GET` is bound by dev's route (Cloudflare tunnel and the old VM's relay) and by media-service
streaming from Garage, **neither of which is production's path**.

### Segment length and quality (run C, Mi 9T broadcasting, 4-5 min each)

| Variant | Uplink | Upload p50 | Glass-to-glass p50 (iPhone / PC) | Stalled (iPhone / PC) |
| --- | --- | --- | --- | --- |
| 720p, **1 s** | 3.09 Mb/s | 0.46 s | 6.3 / 6.1 s | 6.8 % / 7.3 % |
| 720p, **2 s** (run A) | 3.08 Mb/s | 0.65 s | 7.3 / 7.3 s | 3.2 % / 4.8 % |
| 720p, **4 s** | 3.15 Mb/s | 1.00 s | 7.7 / 7.7 s | **14 % / 15 %** |
| **480p**, 2 s, 1.2 Mb/s target | 2.59 Mb/s | 0.58 s | 7.2 / 7.2 s | 7.6 % / 6.4 % |
| 720p, 2 s, 1.5 Mb/s target | 2.60 Mb/s | - | - | - |

**Recommendation, from these numbers.**

- **Quality: 720p, one tier, the target asked at 2.0 Mb/s.** 480p saves 16 % of the Android uplink
  (3.08 -> 2.59 Mb/s) because the encoder floors at ~2.6 Mb/s, and buys no latency; a 720p request
  under 2.5 Mb/s already lands on that floor. Plan the egress on **~3.1 Mb/s per viewer for an
  Android broadcaster and ~2.3 Mb/s for an iPhone** - so the host-uplink formula above uses 3.1, not
  1.5.
- **Segment: 2 s, keyframe every 2 s.** 1 s saves about a second but doubles the requests (an
  ingest at the server's one-per-second floor, a `GET` per second per viewer) and stalled twice as
  often; 4 s is worse on every column.
- **For WP-L5's player** (_superseded 2026-10-27 by [the buffer policy](#the-buffer-policy-l-f1-2026-10-27): a measured target, 3 s at least_): hold about one segment of buffer (the bench's 1 s-behind-the-end target
  starved at 4 s segments and drifted to 3 s behind at 2 s), and **seek to the live edge after any
  gap** (seen after both background tests: 22 s behind, then caught up by a seek). Join on the init
  plus the newest segment - it worked on every join, on both engines, because every segment starts
  on a keyframe.
- **For WP-L5's broadcaster**: retry an index until it lands and never skip one (the ingest is
  in-order; the bench lost an index to a 14 s background failure and every later one was
  `409 LIVE_SEGMENT_OUT_OF_ORDER`); show the Android broadcaster that leaving the app ends the camera
  (re-acquire on return, inside the 60 s window); warn below ~60 % battery on Android.
- **GO for WP-L5 on this transport.** No iOS blocker was found: Safari's WebKit records fMP4 with
  keyframe-aligned segments, uploads at 17 Mb/s, and plays a growing source through
  `ManagedMediaSource` with no append error; the app's WKWebView already plays `ManagedMediaSource`
  for segmented posts (the iPhone 12 column of the R2 table in
  [media-service](../../services/media-service.md#segmented-media-play-while-downloading-canareels-r2---the-reader-release-2026-10-01)).

**What could NOT be measured, and why.**

- **The iOS app's WKWebView as broadcaster or live viewer**: the TestFlight build is not
  inspectable, and a bench build (`ios.yml` with devtools) would replace it. Safari and WKWebView
  share WebKit; `getUserMedia` + `MediaRecorder` in the WKWebView are already exercised by the
  CanaReels camera, and `ManagedMediaSource` by the segmented reader - but **a background test of the
  app's camera on iOS** (does the track mute, as in Safari, or end, as in the Android WebView) is owed.
- **Battery unplugged**: both phones stayed on USB, so the Mi 9T figure is a drain the port could not
  cover (a floor, not the real rate) and the iPhone's is unreadable. The 2026-10-18 unplugged capture
  without upload was ~59 %/h on the Mi 9T and ~14-28 %/h on the iPhone; with the upload it can only
  be higher. A 30 min unplugged run with the upload needs the cables pulled by hand.
- **Heat on the iPhone** (no temperature in `diagnostics battery`), and the Mi 9T's CPU and GPU
  temperatures during run A (the sampler read a cached value; fixed for run C: CPU4 up to 56.5 C,
  GPU up to 49.8 C, thermal status 0).
- **Cellular**: no SIM in either phone; every number is Wi-Fi.
- **Production's path and the host's usable uplink** (Q3): dev goes through a Cloudflare tunnel and
  the old VM's relay, so the `GET` times above say nothing about production; the uplink is the
  DSI's answer, and WP-L4's nginx serving is not built.
- **Many viewers**: three at a time here, which says nothing about the server at 30 or 300.

## Uncapped audience - the plan (2026-10-20)

> **Revised 2026-10-21 by [live-scaling](live-scaling.md)** (the owner: no VISIBLE ceiling): Cloudflare's terms are now read and restrict the Cache Rule below, so the delivery recommendation there is an R2 bucket; the bounds, the options and the staged path are on that page.

The user, 2026-10-20: *"Je ne veux pas de plafond."* **Restated 2026-10-21 as a STANDING WISH: no
visible audience ceiling for a live, "the technique must follow".** The cap of 24 is a TEMPORARY
technical bound, and the "live complet" screen is NOT a product feature - nothing is to be built on
it or around it, and it goes with the cap. Nothing here is built and no infrastructure is
touched; this is the work an uncapped audience needs, in the order it should be measured. **What the
cap protects.** The cap of 24 ([the viewer cap](../../services/lives.md#the-viewer-cap-wp-l4)) exists because every
viewer's copy of every segment leaves the school host's uplink (~90 Mb/s measured, 3 Mb/s a viewer) from
Canari's own nginx. Removing the number without removing that cost makes the host the victim: 1 000
viewers are 3 Gb/s, 1.35 TB per live-hour (3 Mb/s x 3 600 s = 1.35 GB a copy), against a link shared
with production, dev and the school's other sites.

### What makes it possible: the segments are identical for every viewer

A segment is ciphertext under the live key; its URL is two uuids, the second chosen at random by the
server and learned only from the manifest; the public route checks nothing per viewer
([lives](../../services/lives.md#serving-a-segment-from-the-nginx-cache-wp-l4)). The content is protected by the KEY and
the MANIFEST, never by the fetch, so a cache anywhere may hold the bytes without learning anything:
**delivery can be offloaded without touching the seal, the key route or the removal rule.** What an
edge copy adds to the threat model is retention outside the host: an ended live's ciphertext may
outlive the live, harmless without a key (deleted with the row) but to be said in the register (C19)
and bounded by a short edge TTL.

### The delivery: sealed segments from a Cloudflare cache

| Question | Reading |
| --- | --- |
| Can Canari put Cloudflare in front of `canari.emse.fr`? | **No.** The school owns that zone and refused to delegate it ([estate-migration](../../infrastructure/estate-migration.md)); production answers from the host's nginx with no `cf-ray` ([realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md) 1b). A CNAME-only setup of a subdomain is a paid-plan feature _(unverified, not read)_ and still needs the school's DNS record |
| What can? | **A hostname on the `canari-emse.fr` zone, which is ours** and already proxied to a Cloudflare Tunnel: a name dedicated to segments, with a Cache Rule on `starts_with(http.request.uri.path, "/api/media/public/live/")` (the field is the PATH and the wildcard matches the whole path, [cloudflare-edge](../../infrastructure/cloudflare-edge.md#the-edge-caches-by-file-extension-not-by-what-the-origin-asks-for): a segment has no extension, so the default extension list never caches it) |
| Who chooses the host? | **The server, in the manifest**, as a single `segmentBase` per estate: no client-side fallback to the origin (a fallback is a signal, never a path). Dev, where the edge is the only path, and a local estate answer their own value. The web app's CSP `connect-src 'self'` then needs that host added, and CORS must stop varying (below) |
| Cache key | The path and nothing else: two uuids, so already unique per segment, immutable once written. The origin route already 404s any query and any non-canonical spelling, so no query can fan out keys |
| Headers the origin must send | `Cache-Control: public, max-age=<short>` on a 200 only; **`no-store` on every other status** (a 404 for a not-yet-visible segment or a 410 for an ended live must never be cached); today media-service sets none and nginx's own cache decides locally. **No `Vary: Origin`**: the segment location echoes the caller's origin for CORS, and a shared cache holds ONE variant per key, so the first origin to fill it would be served to every other. A segment fetch needs no credentials, so a fixed `Access-Control-Allow-Origin: *` on that one location is the shape to measure |
| TTL | Short, minutes: a viewer lags the live by 5-10 s and a manifest lists 10 segments, so a segment is useful for about a minute. Short TTL is also the bound on retention outside the host. A single-file purge by URL at the end is possible but is not the control (the key is) |
| The path from edge to host | **The tunnel, which measured ~19 Mb/s on a MISS whatever the parallelism**, and it also carries dev and the SSH path ([realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md) 2b, 3d). Only MISSES cross it: one fetch per segment per edge location. At 3 Mb/s a live that one location fills costs the tunnel 3 Mb/s, so **about six lives whose segments are all missed**, whatever the audience - this is the number that replaces the cap, and it moves with how many edge locations the audience spans (**tiered caching** collapses them to one upper tier; its availability on this plan is _unverified_) |
| The tunnel's weakness | It dropped in a 22h band in September and was not re-observed since ([cloudflare-edge](../../infrastructure/cloudflare-edge.md#the-tunnel-drops-in-the-22h-band-and-nothing-on-this-page-can-fix-it)); a 1033 stops every live's segments at once. Viewers already past the cache would keep playing for the TTL. An accepted, stated failure mode, not one to hide behind a second path |
| Cloudflare's terms | **READ 2026-10-21: video through the CDN needs a Paid Service (Developer Platform, Images, Stream) unless Enterprise - this Cache Rule is the restricted case ([live-scaling](live-scaling.md#a-segments-from-cloudflare-not-from-the-host)).** Was: **The risk to settle FIRST.** The self-serve terms have restricted serving video or a disproportionate share of non-HTML content through the CDN unless a Cloudflare video or storage product carries it _(from memory of the published text, unverified against today's)_. Segments are exactly that content. Read the current terms and, if in doubt, ask Cloudflare before building: an account action would take the whole zone, production's old name included |
| Cost | No per-GB charge for CDN traffic on the plans in use _(unverified)_; the alternatives that the terms bless are **R2** (an object store with no egress fee: sealed segments written there instead of Garage - a second store, a second erase path, and a change to the ingest) and **Stream** (transcodes, sees plaintext, per-minute price: refused by the E2E design). R2 is the one to price if the terms refuse the cache |
| What it does NOT remove | Everything that is not a segment: the manifest, the key, the chat, the seats, below |

### The manifest poll grows with the audience too

Every viewer polls once a second, and each poll costs an `auth_request` sub-request, the watch-rule
query, a Redis script renewing the seat and, with `chat=1`, the chat reads. **N viewers are N
requests a second into social-service and Postgres, whose pool is 10 connections** (ingest alone may
hold 4). At 24 that is invisible; at 1 000 it is the next wall, and the edge does nothing for it
because the manifest is per-viewer by design (the segment names are the capability).

- **Split the gate from the tail.** The decision "may this account watch" (spaces, blocks, removal,
  seat) changes rarely; the tail (the last segments, the chat after a cursor, the reactions sums) is
  the same for every viewer of a live. Check the gate on a lease (the 30 s seat lease already is one:
  a poll inside it need not re-run the watch rule) and answer the tail from a one-second micro-cache
  of Canari's nginx or a per-live in-process snapshot, keyed by the live id. One database read a second
  per LIVE, not per viewer.
- **What the tail may not carry per viewer today** and must stop carrying: the chat filtered by the
  viewer's blocks (C10) and the viewer's own reaction bursts removed (C7). Both become the CLIENT's
  job (it knows its blocks and its burst ids), which changes a statement: a blocked author's sealed
  lines are then SERVED to the blocker's client and dropped there. Ciphertext the viewer holds the
  key to, but it is a decision of the user's, not a refactor.
- **Poll interval.** The picture is 5-10 s behind; a 2 s poll costs a second of chat latency and halves
  the load. A server-told `pollAfterMs` (as `retryAfterMs` is told, never a constant in the client)
  lets load shape itself without a deploy.
- **Connections, the ceiling that remains.** A seated viewer holds up to four connections, three once
  its segments come from the edge (app, WebSocket and its upstream leg). The shared host's proxy has
  one connection budget for ALL its sites and raising it is the school IT department's decision. **So even
  with the edge, "no cap" is an audience of several hundred, not unbounded**, until the manifest too
  stops reaching the host. That figure goes to the user as it is.

### The viewer count is a signal, not a gate

The seat sorted set (`live:seats`, one Lua script a poll) already knows who is watching within the
30 s lease. Uncapped, the grant stops refusing and the set only COUNTS: `ZCARD` per live (one set per
live then, since the count walks the shared set today), shown to the broadcaster and to viewers -
**the owner decided 2026-10-21 that viewers see it, EXACT and not rounded (confirmed by the owner
2026-10-21)** ([the viewer count](#the-viewer-count-2026-10-21)). It stays
the removal point (a removed viewer's seat is freed and its key refused) and the load figure the
bitrate choice of D2 reads. A seat renewed every poll is N Redis scripts a second: renew once per
lease interval, as the gate-on-a-lease change above does. `LIVE_FULL`, its screen and
`LIVE_SEATS_UNAVAILABLE` (Redis down refused everyone, to protect a cap that no longer exists) change
meaning: with no cap, a Redis outage should not stop playback - **a decision to state when the cap
goes, not before**.

### Abuse limits that are not a viewer cap

A cap refuses a person; these refuse a behaviour and keep the door open to the next honest viewer.

| Limit | Shape | Why it is not a cap |
| --- | --- | --- |
| Segment fetches per address | nginx `limit_req` exists (30 r/s burst 60). **`limit_conn ... 24` per address is the cap in disguise**: a lecture hall behind one campus address with 24+ viewers is refused. It must become a rate, or rise to a figure measured against the campus NAT | The same address may host a whole room |
| Manifest polls per account per live | a floor on the interval (a poll faster than the told `pollAfterMs` / 2 answers `429` with `retryAfterMs` from the rows' clock, as the chat limits do) | Per account, so one viewer cannot cost a thousand |
| Key reads per account per live | a count in durable state per rolling minute | A key is read once; a script reading it in a loop is the abuse |
| Admission RATE per live | at most R new viewers a second per live, over that a `429` with a jittered `retryAfterMs` | **The push to the followers is a thundering herd**: a hundred notifications open the live in the same second. A rate smooths it and refuses nobody for good |
| Chat and reactions | already per account per live (C6) | unchanged |
| A global ceiling on the HOST's egress | a measured alarm, never a gate: when the origin's egress passes a threshold, a person decides | The alarm says "the plan failed", the cap said "no" |

### Measurements before anything is activated

Run on the LOCAL estate with headless viewers first (Q3 of the plan; **a load test on the shared host
is not ours to run unasked**), then on dev behind its real edge, then one announced reading on
production.

1. **Cloudflare's current terms for video through the cache**: read, and the answer written here.
2. **Edge hit ratio** on segments (`cf-cache-status`: HIT, MISS, DYNAMIC; the first request of a path
   with no extension is DYNAMIC until the Cache Rule exists), per live, over 10 and 100 headless viewers.
3. **Origin egress per live-hour** on the tunnel and on the host's interface: the MISS bytes. It
   should be ~1.35 GB a live-hour per edge location filling it, independent of N.
4. **Tunnel ceiling with several lives**: segments of 2, 4, 6 simultaneous lives through the tunnel
   against its ~19 Mb/s, with dev's traffic running.
5. **Manifest QPS and its cost**: requests a second at N, social-service CPU, Postgres pool wait and
   Redis scripts a second, before and after the gate/tail split.
6. **Host connections held** at N viewers (`ss` on the host: the host-wide budget, read, never raised by us).
7. **Latency to the live edge** with the edge in the path: does the cache add to the 5-10 s?
8. **The admission spike**: the real size of a follower fan-out at the moment of a push.
9. **A 1033 during a live**: what a viewer sees, and for how long the cache covers it.

**Order of work once the user says go**: the terms (1), then the manifest split (it helps at 24 too and
needs no edge), then the cache headers and the segment host, then the abuse rates, and the cap goes
only when 2-6 hold.

## Decisions of 2026-10-19

User calls, taken after the server half (WP-L2, WP-L3) was built. They supersede L7 and change what blocks a stable.

- **D1 - lives come BEFORE the calls revival** (supersedes L7 of 2026-10-15). WP-L0 no longer precedes the lives; in-app calls were compiled in by the flip PR of 2026-10-22 (`CALLS_COMPILED = true`, held shut by the server's `calls_mode`; [calls](calls.md)).
- **D2 - bitrate is fixed at launch by the server.** v1 picks 720p or 480p from the TOTAL live load at the moment the live starts, and never changes it mid-live. The server transcodes nothing. Mid-live adaptive bitrate is NOT v1: MediaRecorder cannot reliably change resolution or bitrate without a new init segment.
- **D3 - any member may start a live in v1, so WP-L8 is a RELEASE BLOCKER.** Moderation (hide message, remove viewer, block, report a live, staff remote cut) and the per-account limits already built must exist before any stable. Apple guideline 1.2 and the Play UGC answers (Q2) precede any store submission.
- **D4 - a "X est en live" notification**, like "X a publié", is wanted. The server half (WP-L7) is built (#2106, spaces respected like a post); a tap lands on the feed, and the client LIVE card and the live's own viewer route are owed.
- **D5 - live comments and floating reactions are wanted** (WP-L6: encrypted with the live key, ephemeral).
- **D6 - moderation works like posts.** A live is reported through the same `content_reports` path as a post ([moderation-and-blocking](../../moderation-and-blocking.md)); where a post's action is "delete the post", a live's is "cut the live" (staff remote cut, WP-L8). The broadcaster's own remove-viewer and message hiding stay. The posts moderation code is REUSED, not duplicated.

**Open question (user, 2026-10-19): "why ask the school IT department for agreement?"** Only raising the SHARED HOST's nginx connection budget (about 1500 across all the host's sites, a host-level setting owned by the school IT department) needs it, under the standing rule of CLAUDE.md. Canari's own edge container is ours. Not needed until an audience would exceed the current budget.

## Decisions of 2026-10-20

The user's answers to the moderation questions, in full on [lives](../../services/lives.md#decisions-of-2026-10-20-moderation-reactions-the-audience) (**the server half of the ladder, the 90 days, the reported chat line, the five reactions and the rules version 2 are BUILT 2026-10-21, WP-L8b** - [the ladder](../../services/lives.md#the-strike-ladder-wp-l8b), [the reported line](../../services/lives.md#a-reported-chat-line-wp-l8b); the 24 h alarm and the viewer cap are not): **strike policy** warning, then suspension of the right to broadcast, then withdrawal by staff; a cut is kept **90 days**; **no automatic cut** on N reports; live reports answered within **24 h**; **a reported chat line is kept (encrypted, for staff) until handled - this REVERSES C2** ([the consequences](../../services/lives.md#a-reported-chat-line-is-kept-until-handled-reverses-c2)); the **floating reactions** are heart, laugh, bravo, fire and the canary chick; the **first-live rules are the posts' rules**, no live-specific clause; **no viewer cap** ([the plan](#uncapped-audience---the-plan-2026-10-20)).

## The client foundation (2026-10-19)

`frontend/src/lib/live/`, shared by the viewer and the broadcaster of WP-L5. No screen, no
user-visible string.

| File | What it holds |
| --- | --- |
| `types.ts` | The wire shapes, read from `apps/social-service/src/lives/` (dates are ISO strings), every refusal `code`, and `LiveRefusalKind` - what a screen does with a refusal. |
| `api.ts` | One function per route over `apiFetch` (`startLive`, `fetchLive`, `fetchLiveManifest`, `putLiveSegment`, `endLive`, `leaveLiveSeat`, `removeLiveViewer`, `listOpenLives`, `fetchLiveLimits`), the token-free segment fetch (`fetchLiveSegment`, no custom header so no CORS preflight), and `LiveSegmentUploader`, the broadcaster's one sender: in index order, the same index retried on a transport failure, a `retry-segment` code or a `429`, stopped by any other verdict (a `410` once the server ended the live). It is the ONE index counter: the caller reads `nextIndex` BEFORE sealing (the seal binds the index), then calls `enqueue(index, sealed)`, which throws a `RangeError` unless `index === nextIndex` - a segment sealed for another index would be stored and never open for any viewer, silently. |
| `constants.ts` | The v1 capture and playback numbers from the WP-L1 bench (measured 2026-10-19, written up in draft PR #2109): 720p, 2.0 Mb/s asked, 2 s segments and keyframes, the player's smallest buffer target (one segment plus one poll) and its cadence window, a 1 s manifest poll (a choice: the bench polled at 500 ms), 3.1 Mb/s per viewer for planning. Every number the SERVER enforces comes from `GET /api/lives/limits`, never from here. |
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
- **Random IVs under one key** are safe at this volume. The assumption: about 1000 accounts
  chatting at once, each at the C6 ceiling of 3 messages per 5 s (2160 per account per hour), so a
  live hour is about 2 million chat seals plus 1800 segments (2 s each), about 2^21 seals under one
  key. The collision chance for random 96-bit IVs is then about 2^-55, and the count far below
  GCM's 2^32 random-IV bound; ten times the chatters still leaves it below 2^25.

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

WP-L5's VIEWER half, **behind `LIVE_ENABLED` (`frontend/src/lib/features.ts`): on in every build
since the production flip of 2026-10-30** (dev builds only before it, by the `deployEnvironment()`
test). Whether a surface is drawn is the server's runtime kill switch, below. The
chat and reactions (WP-L6) are [below](#the-chat-and-the-floating-reactions-client-half-wp-l6-2026-10-19-draft); moderation (WP-L8) is merged.

### The server's kill switch hides the live surfaces (2026-10-21)

The build switch is not enough once it ships: a store binary cannot be recalled. So every live
surface - the feed card, the viewer, the composer's Live chip - is drawn only when
`livesAvailable(serverLivesMode())` holds (`utils/livesAvailability.ts`): `LIVE_ENABLED` AND the
server's runtime kill switch `platform_config.lives_mode` set to `on`, as `/api/version` last
published it (`lives: { mode }`, parsed by `parseServerVersionInfo`; absent or unknown reads `off`).
It is reactive on the version check, so an admin closing lives takes the card and an open viewer away
at the next refresh (focus, reconnect, mount). An open BROADCAST screen is not torn down by it: its
next segment meets the server's `404`, classified `disabled` by `lib/live/api.ts` (what that screen
then shows on a flip was not read on a phone). The server refuses on
every request whatever the client draws ([lives](../../services/lives.md#the-two-switches-live_enabled-and-lives_mode));
the admin control is `/admin/platform`, built like the calls one (a save sends only the fields that
changed, and is refused when nothing loaded). `livesModesAgree.test.ts` holds the six spellings of
the two values together.

| File | What it holds |
| --- | --- |
| `lib/live/livePlayer.ts` | The MSE player and its state machine; everything outside it (API, seal, media source, timer, the monotonic clock) injected, so it is tested with fake MSE objects and a manual clock |
| `lib/live/liveBufferPolicy.ts` | [The buffer policy](#the-buffer-policy-l-f1-2026-10-27): `classifyLiveWait` (what a `waiting` means) and `LiveBufferPolicy` (the target from the measured delivery cadence). Pure, no timer |
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
3. The join on the NEWEST `LIVE_PLAYER_JOIN_SEGMENTS` (two) segments. Every segment is SELF-CONTAINED - the recorder's init
   (`ftyp` + `moov`) then one fragment (`moof` + `mdat`), the [broadcaster's shape](#every-segment-is-self-contained) - so
   their init is appended, then their fragments, then a seek to `end - target`, the
   [buffer policy's](#the-buffer-policy-l-f1-2026-10-27) target (4 s at the join: the 3 s floor wait plus a poll). Only the newest one is required;
   a first segment with no init is "Live indisponible" (`playback`).
4. A poll every `LIVE_MANIFEST_POLL_MS` from `last + 1`, segments taken in order. **A segment's init
   is appended only when its bytes DIFFER from the last one appended** (a camera re-acquired
   mid-live, e.g. a rotation); an identical one is skipped. MSE allows a new initialization segment
   in the same `SourceBuffer` while the codec STRING is unchanged - resolution, SPS/PPS and audio
   configuration may change; a different codec string would need `SourceBuffer.changeType()`, which
   is not called because the recorder's type is the fixed `LIVE_RECORDER_MIME`. `mode = 'segments'`
   keeps each fragment at its own timestamps, so a re-acquire (timestamps moved FORWARD by the time
   away) opens a second buffered range: the `waiting` at the end of the first seeks across at once,
   and a drift past the target plus `LIVE_PLAYER_DRIFT_SLACK_MS` does the same - one seek, never a loop.
   **The jump to the live edge**: a backlog behind the manifest's `nextIndex` whose media would put
   the video past the target plus its slack anyway (`LiveBufferPolicy.isBacklog`, sized by the
   longest segment measured - four 2 s segments at the floor are played, a fifth is a backlog) asks for the NEWEST window (`?from=` answers the OLDEST ten from that index) and
   takes only its newest segment; a STARVED `waiting` since the last segment (never the wait of a
   seek) re-anchors at the next one, at the policy's target. Each
   poll that brings media calls `play()` if something paused the video. What was played more than
   `LIVE_PLAYER_KEEP_BEHIND_MS` ago is removed.

### The buffer policy (L-F1, 2026-10-27)

**The cause of L-F1, read from the rig's own consoles** (LIVE-WEB-2 and -3, 2026-10-26, Mi 9T app
broadcasting to two Chrome viewers; the dev containers were redeployed since, so the server's side
of that run is gone). Two defects, each enough to freeze a viewer:

1. **The target was smaller than the producer's cadence.** The Mi 9T's recorder handed over its
   init alone at +2.1 s, nothing at the next 2 s tick, three fragments at the one after, then its
   fragments sealed 4-15 ms apart at EVERY other tick: `seal index 3` and `4` at 20.320/20.328, `5` and `6` at 24.326/24.341 - a pair every
   4.0 s, on every chunk of both readings (against 14 % of chunks in WP-L1). The viewer sat a fixed
   `LIVE_PLAYER_TARGET_BUFFER_MS` = 2 s behind, so between pairs it ran dry for ~2 s.
2. **The player read its own seek as a stall.** Every `seek to the live edge (...) at E` was followed
   IN THE SAME MILLISECOND by `stalled at E - 2.00` (`at 9.99` / `stalled at 7.99`, `at 12.01` /
   `stalled at 10.01`): the engine fires `waiting` while it completes a seek. The stall latched, the
   next delivery seeked again (`(stall)`), whose own `waiting` latched again - **a seek at every
   delivery for the whole live**, 3 to 5 seeks in 8 s per viewer.

**The policy** (`liveBufferPolicy.ts`, applied by `livePlayer.ts`):

- **A `waiting` is classified once** (`classifyLiveWait`, typed `LiveWait`): `seeking` when
  `video.seeking` holds (logged, nothing else); `held` when the range holding the playhead has more
  than 0.5 s of media past it; `time-gap` when media lies past a hole ahead (a re-acquired camera,
  crossed at once); `starved` otherwise, which latches the re-anchor.
- **A wait with media ahead is the engine's own, and is no stall** (LIVE-STALL-1, `1.5.1-alpha.8`,
  2026-10-29). W4 logged `stalled at 55.56` at 23:23:04.085. The delivery 3.5 s earlier had left
  52.03 -> 58.19 in ONE range (`ahead 6.17`, which is read from the range holding the playhead, so
  no hole lay before 58.19), and the playhead had advanced at exactly 1x since. It then played on BY
  ITSELF to 55.74 before the next delivery's line, which is printed before any seek. So nothing was
  missing ahead: Chrome fires `waiting` when its decoder or renderer underflows too, and a rig
  running three browsers and an emulator is where that happens. The old player latched it as
  starvation and the next delivery seeked FORWARD to 56.18. That skipped 0.44 s of media for a wait
  no seek shortens, and it failed the row. Now `held` logs `waiting at T with A s buffered ahead
  [ranges] - the engine's own wait`, with no latch and no seek. The NEXT delivery settles it. The
  wait ENDED only if the engine says it plays on: the playhead moved, `readyState` is at least
  `HAVE_FUTURE_DATA`, and the video is not paused. A sub-frame creep (WebKit), or a recovery that
  froze again without a second `waiting`, does not count as an end. An ended wait logs `the
  engine's own wait at T ended by itself after W ms, now at T': held about H ms (budget B ms)`.
  H is the wall time W minus the media played since. A wait that did not end writes the ordinary
  `stalled at T` line, and the delivery re-anchors as for any stall. The proof is the engine's
  state at a delivery the poll was making anyway, not a timer. A seek closes the open wait.
- **The budget, and the decision behind it** (owner, 2026-10-29). A wait of the engine's own that
  holds the picture for at most `LIVE_PLAYER_HELD_WAIT_BUDGET_MS` = 500 ms (`constants.ts`) is no
  longer a stall. No policy constant measures a freeze, so half a second was chosen: about where a
  viewer reads a pause as a hitch. **This moves the bar of LIVE-STALL-1, knowingly**: the old
  forward seek cost the viewer media for a wait that no seek shortens. The rig's judge
  (`liverows.mjs`) IMPORTS the same constant. It still fails a viewer on a hold over the budget,
  and on a wait no delivery showed ended, before the first delivery gap too. Still unknown: WHY the
  engine underflowed, which no line here can name.
- **The longest wait is BOUNDED from the shape of the deliveries, before a gap proves it**
  (LIVE-STALL-1, `1.5.1-alpha.7`, 2026-10-29). `longestWaitMs` is the largest of: the floor
  `LIVE_PLAYER_MIN_TARGET_BUFFER_MS` = one segment plus one poll (3 s, where the WP-L1 Mi 9T viewer
  played 21 min with 0 stalls); the longest wall-clock gap between two deliveries over the last
  `LIVE_PLAYER_CADENCE_WINDOW` (30); and the GROUP BOUND - the most segments one delivery brought,
  times the longest segment measured (the buffered end's growth, unless a hole opened), plus one
  poll. A delivery of K segments means the producer withheld K segments of media, so its next
  handover can come that much later, learnt up to a poll after. A pair of 2 s segments bounds the
  wait at ~5 s AT the pair. The clock is the injected monotonic `now()`: READ to measure a gap, never
  waited on.
- **The anchor sits one poll past that wait** (`targetMs`): a delivery's phase against the poll
  moves by up to one poll, so an anchor exactly at the wait would re-anchor on ordinary jitter. 4 s
  at the floor, ~6 s behind a paired producer.
- **A delivery that leaves less media ahead than the longest wait re-anchors at once**
  (`reanchor` -> `short`, a seek line `(short)`), never left to stall. Before, the target grew only
  AFTER a longer gap had drained the buffer, and was applied only at a seek: W4 held 3.99 s after a
  delivery with its target at 4118 ms, the next gap was 4223 ms, and it stalled. A buffer that does
  not hold the target behind its edge is left to fill (a clamped seek would replay its start at
  every delivery). Drift seeks past target + `LIVE_PLAYER_DRIFT_SLACK_MS` (`drift`).
- **The replay** (`liveBufferPolicy.test.ts`, "LIVE-STALL-1, replayed"): W4's twenty recorded
  deliveries (gap, segments, media), played at the wall's pace from the state the first left (which
  reproduces every recorded "ahead" to 0.02 s up to the stall). The rule this replaced stalls at
  delivery 10, the rig's stall (and 10 ms short before delivery 13, where the rig's video, slowed
  70 ms by its stall seek, did not). This policy: one re-anchor at the first pair, no stall, and
  never under 1.3 s ahead after it.
- **A stall latched while a delivery is awaited is re-anchored on that delivery** (LIVE-STALL-1,
  2026-10-29). The poll reads the stall latch AFTER its segment fetches, opens and appends, never
  before them, and only the re-anchor it asks for (`seekToEdge` answering that it seeked) clears it.
  Before, the poll snapshotted the latch as the manifest arrived and cleared it unconditionally after
  the appends, so a `waiting` that fired DURING the fetch was wiped with no seek and the viewer
  stalled again seconds later (W4 on dev `1.5.1-alpha.6`: manifest 44.042, stall latched 44.471,
  segment opened 44.768, stalled again 48.794). A stall latched during the trim that follows stays
  latched for the next delivery. No timer is involved: the rule is the ORDER of the read.
- **One debug line per delivery** says what it did to the buffer: `delivery of N appended of M taken
  (a-b), gap G ms: end E0 -> E1, at T0 -> T1, ahead A0 -> A1 s, ranges [R0] -> [R1]` - `M` segments taken in `a-b`, of
  which `N` were appended (the rest skipped: gone or unopenable); the buffered end, the playhead and the
  media playable ahead of it, before the first fetch and after the last append (before any seek,
  which has its own line). At most one per poll, the bound of the seek line beside it. It separates
  a producer whose segments carry uneven media (`E1 - E0` against `N`) from a player
  that drifts (`T1 - T0` against the gap). `R0`/`R1` are EVERY buffered range (`[a-b c-d]`,
  `formatLiveRanges`), since 2026-10-29: a hole ahead of the playhead shows there and nowhere else.
  The rig forgives it on a viewer seat (`liverows.mjs`).
- **An outage is never a cadence** (`interrupt`, typed `LiveCadenceBreak`): a catch-up jump, a
  retried step, a broadcaster the manifest says is quiet. So a 20 s loss of network never leaves a
  viewer 20 s behind.
- **The join takes the newest two segments**, so the first frame starts with the 4 s anchor ahead.

**The price**: a regular producer (iPhone) is watched 4 s behind its buffer's end (2 s more than
the first 2 s target), an Android producer delivering in pairs ~6 s; and the first pair costs one
backward seek of up to ~2 s (seen video replayed once) where it used to cost a stall. A paired
producer cannot be played smoothly with less buffer than its period plus the poll.

**Not changed, and unverified**: the PRODUCER. Why the Mi 9T's recorder (2 s timeslice, 2 s
keyframes) emits on every other tick only is not known; a shorter timeslice might hand each fragment
over as it completes, but that is a hypothesis no device has read, and installed broadcasters keep
their cadence anyway - which is why the viewer must follow whatever cadence it receives.

**Verified by tests** (`liveBufferPolicy.test.ts`; `livePlayer.test.ts`'s "the buffer policy"
block, whose cases fail against the old player - the `short` re-anchor among them; the mid-fetch stall case holds the segment
fetch open by hand and fails against the player that snapshotted the latch). **Owed on hardware**: L-F1's reading again on
the pre-release that carries it - the Mi 9T broadcasting, a phone AND a browser watching, 0
`stalled` lines past the first delivery gap and no `seek ... (stall)` loop.

**Failure -> screen** (`liveFailureOutcome`, one table, tested):

| What came back | Screen |
| --- | --- |
| `full` (`503 LIVE_FULL`) | "Live complet" with "Réessayer"; no automatic retry (never hammered); no seat to give back |
| `seats-unavailable`, `rate-limited`, `unavailable` (a bare 5xx), `retry-segment`, a transport failure | "Reconnexion...", the same step again after 1 s doubling to 8 s - **never "complet"** |
| `ended` (`410`), or `not-found` once the key was served | "Le live est terminé"; no timer left. Every final screen pauses the video, and gives the seat back: an ordinary end's purge waits for its seated viewers ([lives](../../services/lives.md#deletion-at-the-end-plus-a-sweep-q10-l3)), so a seated viewer reads `410` and fetches the segments its last manifest named; a viewer that joins after the purge reads `404` |
| `not-found` before the key, `removed`, `disabled`, `refused` | the neutral "Live indisponible" |
| An engine with no MSE or no `avc1`/`mp4a` support | "Live indisponible" (`unsupported`) |
| The joining segment that does not open, or three segments in a row | "Live indisponible" (`undecryptable`); one segment that does not open, or one the server no longer has (`404`), is skipped |
| Three failed appends in a row, or the `<video>`'s `error` event | "Live indisponible" (`playback`); the two failure counts are kept apart, so a segment that opens never hides an append that fails |

A `410` whose body says `endReason: 'cut'` (a moderator cut the live, WP-L8) is its OWN screen, `live_viewer_cut_title` ("Ce live a été interrompu par la modération"): `LiveRefusalError.endReason` carries the body's value (a value this build does not know is `null`, never a guess), `isLiveCut` is the one test, and the viewer state is `{ kind: 'ended', cut }`. A `404` after the join is still the plain end: nothing keeps a deleted live's reason to answer it with, so a viewer polling the second after a cut may read "terminé" - the cut screen is for the `410` the server's `live_cuts` row answers.

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
the viewer's switch, the ONE `LIVE_ENABLED`: on in every build since the production flip of
2026-10-30**, with the server's switch in the same commit ([live-production](live-production.md)).
Chat and reactions (WP-L6) and moderation (WP-L8, WP-L8b) were built after this section was written.

| File | What it holds |
| --- | --- |
| `lib/live/fmp4Segments.ts` | The pure fMP4 reader: `Fmp4Splitter` turns recorder chunks into one init and its fragments (a box cut across chunks is carried), reads whether each fragment's video starts on a sync sample, `composeSegment`, and `rebaseFragment` (the media-time shift below) - and the viewer's `initSegmentEnd`, on the same box-header reader. |
| `lib/live/liveSegmentPipeline.ts` | Chunk -> fragments -> segment -> seal -> queue, ONE chunk at a time through one promise chain: the index is read from `uploader.nextIndex`, sealed for and enqueued with (no second counter). A summary line every 15 segments. |
| `lib/live/liveRecorder.ts` | `MediaRecorder` with `LIVE_RECORDER_MIME`, 2.0 Mb/s, 2 s timeslice and keyframe interval; no second container (an engine that cannot record that exact type cannot broadcast, said before Start). |
| `lib/live/liveDevice.ts` | The camera at 1280x720 + microphone (lens asked as the reel camera does: exact on a phone and on a switch, ideal on a desktop's first capture, `utils/cameraFacing.ts`), the Screen Wake Lock (every request carries a ticket, so a lock answered after a release or a newer hold is given straight back: hold -> release -> hold never leaks one), the Battery API reading. |
| `lib/live/liveBroadcast.svelte.ts` | The state machine: `preview -> starting -> live <-> away -> ending -> ended`, every dependency injected. |
| `components/live/LiveOverlay.svelte`, `LiveBroadcaster.svelte` | The full-screen layer (portal, `coversScreen`, one history entry, the edge swipe) and the broadcast screen. The viewer's identity chip is `LiveIdentity`, a different component. |

**The entry.** The post composer's chip row carries "En direct" when `livesAvailable(serverLivesMode())`
holds - `LIVE_ENABLED` AND the server's runtime kill switch on ([below](#the-servers-kill-switch-hides-the-live-surfaces-2026-10-21)). The live
goes out under the identity chosen in the composer: the member, or an association they may post as
(`associationId`; the server checks `POST_AS_ASSO`). Never anonymous: the chip is not drawn while
"anonymous" is chosen, nor while the chosen association is missing from the list read.

**The pre-live screen is the rules, shown before EVERY live (L11)**: visible like a post by the same
identity and only while on air; reportable and cuttable by moderation; with no longest duration (L4, 2026-10-31); the
camera may be away at most `reconnectWindowMs`, read from `GET /api/lives/limits`. A warning
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
generation BREAKS on two things - the chain itself never rejects: a chunk it cannot read (a Blob
read that rejects) or frame, and `MAX_CONSECUTIVE_DROPS` (3, ~6 s) fragments IN A ROW that could not
be sent (a rebase that failed, a seal that threw, a segment over the server's `segmentMaxBytes`). A
single dropped fragment is a gap in the picture and is only counted; a run of them is a recorder
whose output does not get through. Either way the pipeline TELLS the state machine (`onBroken`),
which goes `away` with the camera given back, a sentence saying what the camera records could not
be sent (`awayProblem = 'unsendable'`) and a Retry that starts a fresh recorder. **Before
2026-10-19's review a drop was only counted**, so a recorder whose every segment was over 4 MB stayed
"on air" with nothing sent. **That a new recorder restarts its media time at zero is an ASSUMPTION** WP-L1 did not measure:
LIVE-B1 row 8 reads it.

### Upload health and the end

`LiveSegmentUploader` gained `onRetry(index, attempt, error)`: a retried send shows a quiet
"Reconnexion..." badge with the backlog (a plural), and the next stored segment clears it.

**The backlog is CAPPED in this layer, not the uploader's** (the queue in `api.ts` is unbounded,
~230 MB in ten minutes offline), and **the cause is read from the last segment the server STORED,
not from the count**:

- nothing stored for longer than `reconnectWindowMs` (since the start, before the first, and RESET on every return to air - nothing is stored while
  away, so an absence is never read as silence): the
  broadcast ends itself as `connection-lost` - the server has ended a live that silent anyway;
- still storing, but past `ceil(reconnectWindowMs / LIVE_SEGMENT_MS)` +
  `LIVE_BACKLOG_MARGIN_SEGMENTS` (5) segments waiting: an uplink slower than real time. At 80 % of
  real time the queue grows one segment in five and crosses the cap in ~6 min while the server
  still receives; the live ends as `upload-too-slow` ("the connection sends more slowly than the
  camera records"), never as a lost connection.

Either end drops the queue (`uploader.stop()`) and asks `/end` best-effort. The clock is the
injected monotonic `now`, read only when a segment is queued, stored or retried.

**The End button** (confirmed; Back and the edge swipe ask the same question) stops the recorder -
waiting for its last chunk at most `LIVE_RECORDER_STOP_BOUND_MS` (one segment + 1 s; a recorder
that never fires `stop` is logged and abandoned) - flushes the pipeline, and **gives back the camera
and the screen lock THEN**, before any network wait. What is left is the queue reaching the server,
waited for at most `reconnectWindowMs` (past it the server ended the live by absence; the unsent
queue is dropped, logged); the "ending" screen says so and offers "Quitter sans attendre", which
disposes the screen and ends the live best-effort. Then `POST /end`; a `410` the uploader hears
while the End drains labels the end screen as the server's (or as a cut, below), never as
the member's. On air, a `410` from the uploader ends the screen with no end call - the cause is
`cut` when its `endReason` says so (title `live_broadcast_cut_title`, no sentence under it:
"Votre live a été interrompu par la modération"), `server` otherwise (the sentence no
longer mentions moderation); a cut read on return from the background (`fetchLive` answering `410`
`cut`) and one answering the End are the same cause; any other stopping refusal ends it as failed and calls `/end`; the screen unmounting or
`pagehide` ends what is on air best-effort; a killed app is the server's absence rule. A start refused
`LIVE_ALREADY_OPEN` (a previous screen killed) is not resumed: the member is told it closes within the
minute.

**What the server does not give, so the client does not show it:** who watches - only how many
([the viewer count](#the-viewer-count-2026-10-21), since 2026-10-21). The reason of a `410` is in the body (`endReason`) since WP-L8, and the
two ends that are not the hour or the broadcaster's own (`dropped`, `erased`) still share the
generic sentence.

### The moderation client (WP-L8's client half, 2026-10-19)

Behind `LIVE_ENABLED` (every build since 2026-10-30). The `live_cut` bell row (type `live_cut`, `postId` = the live,
`actorId`/`actorName` empty, `text` = the reason CODE): `NotificationRow` builds the sentence
(`notif_live_cut_text`) and appends the `moderation_reason_*` label, draws a neutral disc instead of
an avatar of nobody, and is NOT activatable (`notificationHref` answers `null`: the live is deleted).
No push yet. The admin queue (`/admin/moderation`, content moderators only - the page already
redirects anyone else, and the server answers `403 LIVE_CUT_FORBIDDEN` regardless): a `live` report
renders `ModerationLiveBlock` (state `open`/`ended`/`cut`/`gone`, broadcaster, start and end, the cut
reason, the live id with a copy control - there is no admin route that opens a live, the viewer is
an overlay - and "N coupures précédentes" when the broadcaster was cut before) and, only on `open`
and `ended`, the "Couper le live" button. It opens `ModerationLiveCutDialog`: reason (the four report
reasons), details (500), then a CONFIRMATION step naming the broadcaster with the repeat count, and
only then `POST /api/lives/:id/cut` through `cutLive`. A repeat (`newlyCut: false`) is still a
success and the page says "already cut"; a refusal gets its own sentence by `code` and returns to
the form.

**The strike ladder's staff half (2026-10-21, built; server #2172).** A `live` report row also carries
the broadcaster's standing (`ReportedLive.broadcasterStanding`, the server's `LiveStanding`: cuts on
record over the rolling 90 days, `suspendedUntil`, `withdrawnAt`, `withdrawalDue`), drawn by
`ModerationLiveBlock` as "N of 3 cuts on record", the suspension's end or the withdrawal's date, and
"the withdrawal is due" - a standing view that needs NO new endpoint, because the queue already reads
it per broadcaster. The "Retirer le droit" button exists ONLY while the server says `withdrawalDue`
(never from a client-side count; `LIVE_WITHDRAWAL_FROM_CUTS` and `LIVE_STRIKE_WINDOW_DAYS` in
`live/constants.ts` only draw the "N of M") and stays offered on a `gone` live, where the broadcaster
is all that is left to restrict. It opens `ModerationLiveWithdrawDialog` (reason, details, one red
confirm) and calls `withdrawBroadcaster` = `POST /api/lives/broadcasters/:userId/withdrawal`; refusals
are sentenced by `code` (`LIVE_WITHDRAWAL_FORBIDDEN`, `LIVE_WITHDRAWAL_NOT_DUE`, the two invalid-input
codes); a repeat (`newlyWithdrawn: false`) is a success the page words "already withdrawn". **Not
built:** lifting a withdrawal (`DELETE` of the same path exists, no control yet) and a standing view
for a broadcaster with no reported live (there is no per-account staff read; the caller's own
`GET /api/lives/standing` is not for staff). Tests: the standing and withdrawal blocks of
`ModerationLiveBlock.svelte.test.ts`.

**The viewer's report control (2026-10-19, built).** `LiveReportControl` sits in the viewer's TOP BAR
(the strip above the picture: it never covers the video, a double-tap region or the chat panel), a
`Flag` icon button named `live_report_button`, hidden on the broadcaster's own copy
(`getSavedUserId() === live.broadcasterId`). It opens the posts' `ReportReasonDialog` (one reason list)
with `createReport('live', live.id, reason)`; the dialog is raised on the `critical` layer through the
new `layer` prop of `Modal`/`ReportReasonDialog`, because `--z-viewer` sits ABOVE `--z-modal` and a plain
modal would open behind the live it is about. Outcomes by TYPE, never by message: `409 ALREADY_REPORTED`
("already reported", closes), `404 LIVE_NOT_FOUND` (`ModerationApiError.isLiveNotFound`: "the live is
over", closes), anything else (a retry, the dialog stays open). Only a report that was FILED offers
"block the person who is broadcasting" through `showConfirm` (danger) and `blockUser(broadcasterId)`;
a block leaves the live through the viewer's own dismissal. The offer says "the person", not the
name: on an association's live the displayed name is the association's, the block lands on the member
who broadcasts. **Reporting ONE chat line is built (WP-L8b client half, 2026-10-21):** a `Flag` button
(`data-live-chat-report`) on every numbered line that is not the reader's own in `LiveChatPanel`, wired
by `LiveViewer` (`report={(line) => (reportedLine = line)}`) to `LiveChatReportDialog`
([decisions of 2026-10-21](#decisions-of-2026-10-21-reactions-rules-and-the-chat-line-report-client-half),
[lives](../../services/lives.md#a-reported-chat-line-wp-l8b)). The viewer's TOP-BAR control still
reports the live or the person. Tests: `LiveReportControl.svelte.test.ts`, the flag in
`LiveViewer.svelte.test.ts`.

**Verified by tests** (fakes for the recorder, camera, uploader and server; no clock, no sleep):
`fmp4Segments.test.ts`, `liveSegmentPipeline.test.ts`, `liveBroadcast.svelte.test.ts`, `liveDevice.test.ts`,
`LiveBroadcaster.svelte.test.ts`, the composer chip in `PostComposerBar.svelte.test.ts`. **Owed on the
phones**: [LIVE-B1](../../device-verification.md#live-b1-the-broadcaster-on-both-bench-phones---owed-on-both) -
ten minutes on air watched, background and return, past the window, a network cut, the end, battery
unplugged, the screen kept on; and whether the iOS app's WKWebView honours
`videoKeyFrameIntervalDuration` (WP-L1 read Safari only).

## The chat and the floating reactions, client half (WP-L6, 2026-10-19, draft)

The server half and its sixteen decisions (C1-C16) are on
[lives](../../services/lives.md#live-chat-and-floating-reactions-wp-l6); this is what the client
does with them. Behind `LIVE_ENABLED` like the rest: the chat exists only inside the viewer.

| File | What it holds |
| --- | --- |
| `lib/live/liveChatCrypto.ts` | The chat seal (C12): `sealLiveChatMessage` / `openLiveChatMessage`, AES-256-GCM under the live key, AAD `canari-live-chat-v1` 0x00 + live id + clientId (16 raw bytes each) + author id; `LiveChatOpenError` (`malformed`, `unauthentic`, `not-text`). A label distinct from the segments', so a segment never opens as a message |
| `lib/live/liveChat.ts` | `LiveChatSession` (no timer of its own), `liveChatSendFailure` (the ONE classification of a failed send), `LiveBroadcasterChatPoller` (the broadcaster's one loop), the five kinds mapped onto the post reactions' emoji and names |
| `lib/live/livePlayer.ts` | The `chat` hook (`LivePlayerChatHook`): `onKey` at the open, `query()` before each manifest request, `receive(block)` after it |
| `components/live/LiveChatPanel.svelte` | The lines (a `log` live region) and the composer; a hide button per line for a moderator |
| `components/live/LiveReactionBar.svelte`, `LiveReactionsLayer.svelte` | The five buttons; the rising floats, at most 24 on screen |
| `components/live/LiveBroadcasterChat.svelte` | The broadcaster's view with hide buttons, mounted by `LiveBroadcaster.svelte` while on air with the live's id and `LiveBroadcast.chatKey` |

**One loop, not two (C3).** The viewer's chat rides the player's manifest poll: the player asks the
session for its cursors before each request (`?chat=1&messagesAfter=&reactionsAfter=`) and hands it
the answer's `chat` block. The session owns no timer, so a stopped player (closed, ended, removed,
full) stops the chat with it; the catch-up's second fetch of the newest window asks no chat, so one
tick never answers a cursor twice. A broadcaster plays nothing, so `LiveBroadcasterChatPoller` is ITS
one loop: the same request once a tick, stopped for good by the server's `410` (or the `404` of a
live deleted at its end), any other failure retried after the player's backoff. The broadcaster
screen mounts it while on air (live or away: the away layer paints over it, and its lines and cursors
survive the camera being taken away), between the top third and the End button.

**A chat refusal that ends the live goes to the screen's OWN decision, never a second rule.** A
write (a message, a hide, a burst) answered `410`, `404` or `403 LIVE_VIEWER_REMOVED`
(`isLiveOverRefusal`) is handed by the session to `onLiveOver`: the viewer passes it to
`LivePlayer.refusedElsewhere`, which runs `liveFailureOutcome` - the player's one decision - and
stops on the screen its own next poll would have shown; the broadcaster's loop and writes pass it to
`LiveBroadcast.chatHeardEnd`, which ends exactly as an uploader `410` does. So a chat `410` whose
`endReason` is `cut` (`isLiveCut`) shows the cut screens - `live_viewer_cut_title` for a viewer,
`live_broadcast_cut_title` for the broadcaster - and any other `410`
the ordinary end, through the same decision the player's poll and the uploader use. A refusal that
is only a retry (`429`, no answer) is the one write's, never the live's.

**Order and idempotence.** **The cursors move when a block ARRIVES** (`receive`, synchronously), not
when its asynchronous opening ends: the next tick's `query()` can run first, and asking from the old
cursors would bring the same rows back - the same reactions floating twice. The rows are then drawn
in arrival order (a promise chain), **each in its own try**: a malformed row (a `null` author, a
missing field) is dropped and logged, and the rest of the block and every later one are still
drawn - one bad row never freezes the chat. A block that arrives before the key is NOT applied and
its cursors do not move (logged at `error`: a wiring defect). A message that does not open is
dropped and logged, never drawn. **Rows are deduped on `author:clientId`**, the server's idempotence
key, not only on the server's id, so a replay under a new id is not drawn twice. My message is drawn
at once as `pending` and replaced by the server's copy matched on its `clientId`, whichever of the
answer and the poll comes first - never drawn twice. **My own echo from the poll is OPENED once**, as
every other viewer opens it; if it does not open, or the server's answer names another author than
the one the seal bound (the account id the client holds differs from the gateway's), the line says
`unreadable` ("Les autres ne peuvent pas lire ce message") and an `error` is logged - never "sent".
A failed send keeps its line with its reason; **a retry re-sends the SAME sealed string**, because
the server's repeat is idempotent for identical bytes only and a re-seal (a fresh IV) would be a
`409 LIVE_MESSAGE_CONFLICT`. Retry is offered for `too-fast` and `network` only; the other failures
offer discard. The list keeps the newest 200 lines. **The account is read at each use**, and the
composer's `canWrite` reactively, so an account that loads after the screen opened enables it then.

**Reactions.** A tap floats at once and is summed; the sums leave as ONE burst on the next `query()`
(one per tick at most, C7), fire and forget - a refused or lost burst is dropped and logged, never
retried (a moment). Past the server's `reactionTapsPerWindow` a tap still floats but is not sent,
since the server would refuse the whole burst. Everyone else's sums float with their counts as each
poll brings them; the server already left my own out (C10). **The layer draws at most 24 floats**
and drops the rest; **with reduced motion nothing moves** - one static counter per kind, the total
since the viewer opened.

**What a line is (C11, C15).** Text, through `EmojiText` (Noto SVG for each emoji): never markup,
never a link, never a mention; the name and the text are each a `<bdi>` (the text `dir="auto"`), so a U+202E in a message cannot reverse the line around it. The composer's `maxlength` is the server's `chatMessageMaxChars`
(read once from `GET /api/lives/limits`), and `send` refuses an empty or longer message before
sealing. Every string is Paraglide (`live_chat_*`, `live_reaction*`).

**Hiding (C14).** The broadcaster's view (`LiveBroadcasterChat`) has a hide button on every line;
the line goes at once on the server's answer, and every viewer's next poll carries the tombstone.
**Staff hide from the viewer** draws the button for the tier the moderation page opens to: a platform
admin, or a member whose BDE holds `MODERATE` (`ensureContentModerator`, probed once at the
viewer's open, cached for the session, read reactively) - the client mirror of the server's
`isContentModerator`, which the hide route checks. A failed probe draws no button and is logged.

**Logs** (`[LIVE_CHAT]`, `LiveChat`): entry and decisions at `debug`, a dropped message, a dropped
burst and a failed send at `warn`, a wiring defect at `error`; lengths and ids only, never the key,
a text or a ciphertext.

**Verified by tests only** (`liveChatCrypto.test.ts` against real WebCrypto, `liveChat.test.ts`,
`livePlayer.test.ts`'s chat block, `api.test.ts`'s chat routes, `LiveChatPanel.svelte.test.ts`,
`LiveViewer.svelte.test.ts`'s chat cases, `LiveBroadcaster.svelte.test.ts`'s on-air chat, `liveBroadcast.svelte.test.ts`'s `chatHeardEnd`). **Owed**: the crypto review of the chat seal, and a phone
reading of the panel, the bar and the floats on the Mi 9T and the iPhone 12 ([backlog](../../backlog.md)).

## The first rig readings, and what they hold against the `lives_mode` flip (LIVE-WEB, 2026-10-27)

Production serves `lives.mode = off`, dev `on`. A finding here **blocks the FLIP of `lives_mode` on
production, not a stable**. Readings on dev `1.4.1-alpha.6`: the Mi 9T (build `349f092c9`) broadcast
as a member, two browsers watched ([board](../../cross-client-testing.md)).

**What held** (LIVE-WEB-2 and -3, both `PASS-DIRTY` on undeclared `[LIVE]` narration):

- Rules accepted, then on air within one second.
- Both viewers saw the feed card on their first refresh, joined, and played 720x1280.
- The broadcaster's count showed 2.
- After End, both viewers showed "Le live est terminé" within 1.5 s.
- Seven segments were sent, none dropped, none off a keyframe.
- The announcement was computed once per live: `[LIVE_ANNOUNCE] ... followers=1` with one follower.
- Chat-delivery answered `No token` for a browser account: a web seat registers no push token, so
  delivery to a follower's DEVICE is owed on a phone signed in as a follower.

| # | Finding | Severity | Owed |
| --- | --- | --- | --- |
| L-F1 | **The viewer freezes about every 4 s.** The Android recorder hands over TWO 2 s fragments at once every ~4 s (paired seals 40 ms apart, on every chunk of the reading, against 14 % of chunks in WP-L1). The viewer plays at `end - LIVE_PLAYER_TARGET_BUFFER_MS`, so it runs dry before the next pair: `[LIVE] viewer ... stalled at N` then `seek to the live edge (stall)`, 4 seeks in 14 s on one viewer, 7 to 11 stall or seek lines per viewer in the next run | **P2, blocks the flip** (a visible freeze); **CAUSE PROVEN AND FIXED 2026-10-27** - the 2 s target against the 4 s pair cadence, AND the player reading its own seek's `waiting` as a stall, which re-seeked at every delivery ([the buffer policy](#the-buffer-policy-l-f1-2026-10-27)) | The same reading on the pre-release that carries the fix, with a PHONE and a browser as viewers |
| L-F2 | Segments of ~45 kB per 2 s (~180 kb/s) against WP-L1's 600-800 kB at 2 Mb/s | observation | A reading with a lit, moving scene before it is called anything: the bench phone's front lens saw a dark, static scene |
| L-F3 | The viewer's manifest poll after the End meets `404` (the row is deleted at the end, [above](#the-viewer-as-built-2026-10-19)), and the BROWSER logs `Failed to load resource ... 404` at error level | designed | The browser's own line cannot be demoted by the app. The rig's LIVE-WEB narration must match it EXACTLY (that live's manifest, after End only, on a viewer) |
| L-F4 | On a phone's first live, the OS camera and microphone prompts send the app to the background in preview (`[LIVE-BROADCAST] app hidden in preview`); the preview recovers once granted | observation | Nothing |
| L-F5 | A desktop browser cannot broadcast: `facingMode: { exact }` in `liveDevice.ts` meets a camera that reports no facing (`OverconstrainedError`, "Canari ne trouve aucune caméra utilisable"). LIVE-WEB-1 `ERROR`. The same request is in `reels/cameraAccess.ts` | **P2**, fix in flight (one shared constraint builder: ideal facing first, exact only on a switch) | LIVE-WEB-1 and a desktop reel-camera row on the pre-release that carries the fix |

## Open questions for the user, each with a recommendation

Answered on 2026-10-15 and moved to the decisions table: viewer cap (L8), simultaneous lives (L9),
followers (L10), safety and age (L11).

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | **Which architecture** (above)? | **C**, with A as an optional small-audience mode later. |
| Q2 | **Apple / Google policy for live UGC.** | Apple's guideline 1.2 asks UGC apps for a way to filter, report and block, and published contact info; Google Play has a UGC policy of the same kind _(both unverified against today's text - read them during WP-L0)_. L6 and L11 cover report, block and cut-off; say so in the review notes, with the video Apple asks for. |
| Q3 | **The bench, and the uplink figure.** | For C: a phone publishing segments to the LOCAL estate, read by 1 then 30 headless viewers, measuring latency, nginx CPU, the phone's uplink, battery and heat over 30-60 min. **The host's usable uplink is a separate reading, and asking the DSI for the link speed and what share Canari may use comes first** (a load test on a shared host is not ours to run unasked). Dev is no stand-in for it: `dev.canari-emse.fr` still goes through the old VM's relay and a Cloudflare tunnel. For A (if kept): the SFU with 1 then 30 subscribers, CPU/RSS and TURN bytes. |
| Q4 | **The key design** (key in the row, rotation when a viewer is removed). | A random 32-byte **live key** in the live row, served like a post CEK to any member who may watch (L2; spaces respected since 2026-10-19). It protects against the storage, a cache and the SFU, **not against a removed viewer**, who already holds it and could re-read the row. So removal is enforced **by the server** (the manifest and the key refused to that account), and rotation is NOT the mechanism: state that limit rather than rotating a key every member can fetch. |
| Q5 | **The broadcaster's network drops.** | With C, the upload is resumable: a **60 s window** in which viewers see "reconnecting"; after it the live ends. **Measured on dev (WP-L1)**: a live whose broadcaster stopped sending ended 77 s after its last stored segment (the window plus the 30 s sweep) and viewers read `410` on their next poll; a 22 s gap was survived and caught up by a seek to the edge. The end is a DURABLE state on the row (`ended_at`), not a timer on the clients. |
| Q6 | **Background and screen lock on phones.** | The broadcaster's camera stops when the app leaves the foreground. **Measured (WP-L1)**: in the Android app's WebView the track ENDS ~6 s after `hidden` and stays ended (a new `getUserMedia` is needed) while the app's `fetch` fails; in iOS Safari it MUTES and resumes on return; the iOS app's WKWebView is not measured. Treat it as a drop (Q5) and say so on screen. No background modes are added for live - they are what App Review refused once. |
| Q7 | **TURN usage.** | Only path A uses TURN (Cloudflare's TURN product; nothing on the host). If A is kept, first check that the host may reach it over UDP at all (outbound is filtered upstream), then ask the DSI for an inbound UDP range in the same request as the calls revival, so viewers reach the SFU directly and TURN relays only those who need it. |
| Q8 | **What does the broadcaster's local save record?** | Its own segments, kept on the phone and offered to the gallery at the end (the C6 save path), never the chat. Confirm. |
| Q9 | **Can a live be scheduled / shown as "upcoming"?** | Not in v1. |
| Q10 | **Live segments' retention.** | Deleted when the live ends (L3), by the same durable state, plus a sweep for any live whose `ended_at` was never written. |

## The work packages, in order

Each starts from a named point and ends on a test that would fail without it. The order assumes
Q1 = C; since 2026-10-19 WP-L0 no longer precedes the lives ([D1](#decisions-of-2026-10-19)).

| WP | What | Starting point | Done when |
| --- | --- | --- | --- |
| **WP-L0** | **Calls revival**: `CALLS_COMPILED`'s switches in one commit (the native ring's `CALLS_NATIVE_RING_COMPILED` later, on its own readings), the SIXTH (no names in a silent invite) and the SEVENTH (`none` level vs. a ring) decided, rung 15 CALL + CALL-13 on real hardware, the by-hand relay-path call, then **the screen recording App Review asks for**. | `frontend/src/lib/features.ts` `CALLS_ENABLED` and the switch table in [calls](calls.md) | the board rows `PASS`; the video recorded; a build accepted with calls on |
| **WP-L1** (**the phone half measured 2026-10-19, [above](#wp-l1---measured-2026-10-19); the host's uplink and the unplugged battery are owed**) | **The C feasibility bench, before any product code**: on both phones, record 720p into short fMP4 segments for 30-60 min, seal and upload them, and play a growing source through MSE in the WebView. **And the host's usable uplink**, from the DSI's answer first (Q3), which sets the viewer cap L8 turns into. | `frontend/src/lib/mediaSegmented.ts`, the camera of [reels](reels.md), the segmented reader | latency, phone uplink, battery and heat measured on Mi 9T and iPhone 12, and the host's usable uplink, written here; or a refutation of C |
| **WP-L2** (**built 2026-10-18, server only, [lives](../../services/lives.md)**) | **The live row and its key**: a `lives` record (broadcaster, as-association, key, `started_at`, `ended_at`), removed-viewer list, the end as durable state. | social-service posts / reels server ([reels (server)](../../services/reels.md)) | API tests: key served as a post CEK to members; refused to a removed viewer; nothing after `ended_at` |
| **WP-L3** (**built 2026-10-18, server only, [lives](../../services/lives.md)**) | **Segment ingest and the manifest**: a growing sealed object or one object per segment, a manifest viewers poll, deletion at `ended_at` plus a sweep (Q10). | the upload session ([media-streaming-upload](../../services/media-streaming-upload.md)) | specs: a segment out of order is refused; the manifest stops at `ended_at`; everything is gone after the sweep |
| **WP-L4** (**built 2026-10-19, server and nginx, [lives](../../services/lives.md#serving-a-segment-from-the-nginx-cache-wp-l4); cap 24 viewers from the measured ~90 Mb/s, [viewer cap](../../services/lives.md#the-viewer-cap-wp-l4)**) | **Segments served by nginx**: an unauthenticated route for sealed live segments answered by Canari's own nginx (cache or static files), never reaching media-service or the database; the per-host viewer cap from WP-L1's uplink figure, refused with a clear "live full" screen. | `infrastructure/local/Dockerfile.frontend` (Canari's nginx), `GET /api/media/public/:id` as the model | a second viewer's fetch is served without a media-service log line; viewer N+1 past the cap is refused |
| **WP-L5** (**viewer and broadcaster built 2026-10-19 behind `LIVE_ENABLED` (dev builds only until the production flip of 2026-10-30), [viewer](#the-viewer-as-built-2026-10-19), [broadcaster](#the-broadcaster-as-built); the phone readings are owed**) | **Broadcaster and viewer UI**: composer "Live" entry, broadcast screen, viewer screen, reconnect state (Q5), first-live rules (L11). | the composer ([posts](posts.md)) and camera ([reels](reels.md)) | e2e on two browser contexts; phone readings on Mi 9T and iPhone 12 |
| **WP-L6** (**server half MERGED (#2131), client half in review (#2136), 2026-10-19 - the client is [here](#the-chat-and-the-floating-reactions-client-half-wp-l6-2026-10-19-draft); the 16 decisions C1-C16 are on [lives](../../services/lives.md#live-chat-and-floating-reactions-wp-l6): PostgreSQL rows erased with the live, carried by the manifest poll, NOT the WS gateway**) | **Live comments and floating reactions ARE wanted (user, 2026-10-19, D5)**, encrypted with the live key, ephemeral. | the manifest poll (`lives.controller.ts`), the segment seal (`liveCrypto.ts`) | tests: messages unreadable without the key; nothing persisted after `ended_at` |
| **WP-L7** (**server half built 2026-10-19, [lives](../../services/lives.md#the-push-to-the-followers-wp-l7-server-half); a tap lands on the feed (`appRouteForDeepLink` owns the `live` host), where the LIVE card is (dev builds only, [viewer](#the-viewer-as-built-2026-10-19)); the live's own viewer route is still owed**) | **Announcement**: LIVE card at the top of the feed; push to followers (L10), sent at the first stored segment. | the feed, `PostNotificationsService` | tests on the follower set incl. mutes; one push per live, never on reconnect |
| **WP-L8** (**RELEASE BLOCKER before any stable, D3; moderation works like posts, D6: reuse the posts code path, no parallel mechanism. SERVER HALF BUILT 2026-10-19** ([lives](../../services/lives.md#moderation-wp-l8-server-half)): a live reported through `content_reports`, the staff cut `POST /api/lives/:id/cut` (410 `endReason: 'cut'`), the first-live rules acceptance recorded (L11), remove-viewer and blocks as built in WP-L2; **client half built 2026-10-19, the viewer's report control included** (cut screens, bell row, admin cut button: [the moderation client](#the-moderation-client-wp-l8s-client-half-2026-10-19); the broadcaster's rules sheet is built), chat hiding inside WP-L6 by the contract written there, and the strike policy and cut retention, the user's) | **Moderation**: hide message, remove viewer, block, report a live through `content_reports` like a post, staff remote cut (the live equivalent of "delete the post"). | `content_reports`, [moderation-and-blocking](../../moderation-and-blocking.md) | tests: a cut ends the live and the row; a report reaches staff while live |
| **WP-L9** (Q2 answers precede any store submission, D3; **the answers and what is missing: [store-ugc-answers](../../store-ugc-answers.md)**) | **Store review**: UGC answers (Q2), the review video for live, then a pre-release to testers. | [mobile](../mobile.md) submission notes | accepted builds on both stores |
| **WP-L10** (only if A is kept) | **Low-latency small-audience mode on the SFU**: a `broadcast` room kind (broadcaster-only publish, receive-only viewers, a cap, a server-side kick), frame E2E keyed by the live key with **no cleartext path**, the SFU bench with 1 then 30 subscribers. | `apps/call-service/src/main.rs` `on_track`, `tests/relay_path.rs`, `CallService.ts` `setupEncryption` | Rust tests: a viewer's track is refused, a kicked peer cannot rejoin; a missing transform refuses to broadcast; TURN GB per live-hour measured |

## See also

- [lives](../../services/lives.md) - the server half as built (WP-L2, WP-L3, WP-L7's push), and its switch

- [calls](calls.md) - the switches and why calls are held off
- [call-service](../../services/call-service.md) - the SFU
- [reels](reels.md) - the chantier this is stage R4 of
- [backlog](../../backlog.md) - the calls-held-off items

## Decisions of 2026-10-21: reactions, rules and the chat-line report (client half)

Built for the owner decisions of 2026-10-20 ([lives](../../services/lives.md#decisions-of-2026-10-20-moderation-reactions-the-audience)); behind `LIVE_ENABLED` (every build since 2026-10-30).

- **Reactions.** `LIVE_REACTION_KINDS` (`lib/live/liveChat.ts`) is `like` (heart), `laugh`, `clap` (bravo), `fire`, `canari`; `love` and `happy` are gone from the type, the bar, the layer and the tests. The emoji and names sit in one table there (`LIVE_REACTION_ART`): the three shared kinds reuse the posts' `post_reaction_name_*` labels, `clap` and `fire` have `live_reaction_name_clap` / `_fire`. Pictures are the Noto SVGs already in the set ([emoji](../emoji.md)); nothing was added. **The server's `LIVE_REACTION_KINDS` must become the same five, or a burst of `clap`/`fire` is refused `400 LIVE_REACTION_INVALID`.**
- **First-live rules.** The sheet shows the posts' rules, i.e. section 5 of the terms of use (`/legal/cgu#regles`): illegal/hateful/privacy, sexual content, harassment, malware and fraud, the sanction line, and a link to the terms. The four live-specific clauses (`live_rules_cut`, `live_rules_responsible`, the old wording) are deleted. **`LIVE_RULES_VERSION` lives on the server only** (the client reads `rulesVersion` from `/api/lives/limits` and `/rules`), so it must be raised there for everyone to re-accept.
- **Report a chat line.** `LiveChatPanel` takes an optional `report(line)` and draws a `Flag` on every numbered line that is not the reader's own; `LiveChatReportDialog` opens the posts' `ReportReasonDialog` on the `critical` layer and calls `createLiveChatReport` (`lib/moderation/api.ts`): `POST /api/moderation/reports { contentType: 'live_chat', contentId: <messageId>, liveId, reason, message: <plaintext> }`. Outcomes by type: `409 ALREADY_REPORTED`, `404 LIVE_NOT_FOUND`, anything else keeps the dialog open. The body shape is the contract agreed with the server half (#2172, below). Tests: `LiveChatReportDialog.svelte.test.ts`, the flag in `LiveChatPanel.svelte.test.ts`.

**Contract with server PR #2172 (2026-10-21).** The reported line has NO client-side length check (the server takes up to 900 UTF-8 bytes; the composer's 300 characters bind only what one writes). Typed outcomes: `409 ALREADY_REPORTED` and `404 LIVE_NOT_FOUND` close the dialog; `400 LIVE_CHAT_REPORT_MISMATCH`, `400 LIVE_CHAT_REPORT_MESSAGE_INVALID` (over 900 bytes) and `503 LIVE_REPORT_SIGNING_UNAVAILABLE` keep it open with their own sentence. The strike ladder's refusals of a start, `LIVE_BROADCAST_SUSPENDED` (with `suspendedUntil`) and `LIVE_BROADCAST_WITHDRAWN`, are LiveRefusalKinds `suspended` / `withdrawn` with a sentence on the pre-live screen, and the notice types `live_suspended` / `live_withdrawn` are known, inert rows like `live_cut`. The standing screen and its buttons are a later PR.

## The viewer count (2026-10-21)

**The owner decided (2026-10-21): viewers see HOW MANY watch a live, like Instagram, and so does the
broadcaster - a count, never a name or a list, to anybody.** The number is **EXACT, not rounded -
confirmed by the owner 2026-10-21**. The server side (what a viewer is, blocked accounts counted, the reasoning on
exactness, what happens when Redis does not answer) is
[lives](../../services/lives.md#the-viewer-count-2026-10-21), the only copy. Behind
`LIVE_ENABLED` (every build since 2026-10-30), like the rest of the live.

- **No new request.** The manifest carries `viewers` (`number | null`). The viewer's `LivePlayer`
  hands it to `onViewers` at the same two places it reads the clock (the join and each poll); the
  broadcaster's `LiveBroadcasterChatPoller` (its one loop, `chat=1`) hands it to its `onViewers`
  argument. `liveViewerCount` (`lib/live/liveViewerCount.ts`) is the one reader: a non-negative
  integer, or `null` - absent (a server older than the field) silently, anything else malformed with
  a `warn`.
- **No stale number.** A failed poll hands `null` too - the viewer's player on every failed poll
  (the reconnecting state), the broadcaster's loop on every failed tick - so a number on screen is
  always the last poll's. The broadcaster's screen also drops it when it goes off air and when a
  NEW live starts, so a second live never opens on the first one's audience.
- **`LiveViewerCount.svelte`**: an `Eye` and the number in a `cn-scrim` pill, in the viewer's top bar
  after the time on air (not on a final screen) and under the broadcaster's ON AIR badge. `null`
  draws nothing, never a placeholder. The number is `aria-hidden`; a screen reader reads
  `live_viewer_count` (`"{count} spectateur(s)"` / `"{count} viewer(s)"`, Paraglide plural forms:
  French singular for 0 and 1, English for 1 only) and is not told every change (`aria-live="off"`,
  which also mutes it inside the broadcaster's `role="status"` row).
- **Tests**: `liveViewerCount.test.ts` (the reader, both languages' plurals), `livePlayer.test.ts`
  and `liveChat.test.ts` (the count from each manifest, no extra fetch), `LiveViewer.svelte.test.ts`
  and `LiveBroadcaster.svelte.test.ts` (drawn, updated, hidden on `null`, on a failed poll, on the
  end screen, and reset for a new live).
- **Owed on hardware**: one look on both phones at the pill next to the badge (check Y's run).

## The viewer header and the rules sheet (2026-10-30, `1.5.2-alpha.1` readings)

- The LIVE pill and the elapsed time sit on a second line under the broadcaster's name, so the name
  takes the header's width and truncates only against the action buttons (`LiveViewer.svelte`).
- The pill is not drawn once the viewer state is `ended`: the ended screen already says so.
- The broadcaster's pre-live rules sheet is capped below the top safe-area inset and scrolls, so it
  never draws under the iOS status bar (`LiveBroadcaster.svelte`).
