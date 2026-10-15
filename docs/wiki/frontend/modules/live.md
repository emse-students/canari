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
| L4 | What does the first version carry? | **A short live with a small audience** - tens of viewers, 30 to 60 minutes at most - with an **ephemeral live chat and floating reactions**; the chat is **encrypted with the live's key**. |
| L5 | How is a live announced? | **A LIVE card at the top of the feed for everyone**, plus a **push ONLY to the followers** of the member or association broadcasting. |
| L6 | How is a live moderated? | **The broadcaster hides chat messages and removes viewers; any viewer can report; staff can cut a live remotely.** |
| L7 | In what order? | **Revive calls first, then live.** The user added that what mostly blocked calls is that **Apple App Review needs a VIDEO recording showing everything works** (still to do), on top of our own tests. |

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

**The egress arithmetic, which is an ESTIMATE until WP-L1 measures it.** The ~1.5 Mb/s per viewer of
C9 is a planning figure, not a measurement. At that rate, 30 viewers for 60 minutes is
45 Mb/s x 3600 s = about **20 GB through TURN per live-hour**, plus the broadcaster's uplink - so
the default 950 GB budget is roughly **45 such lives a month**, shared with every call. Whether
Cloudflare counts the SFU-to-TURN leg and the TURN-to-viewer leg separately is _(unverified)_.

## Open questions for the user, each with a recommendation

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | **Viewer cap and egress budget.** | Hard cap **30 viewers** in v1, refused at join with a clear "live full" screen; a **per-month live-hours budget** carved out of the TURN budget so lives can never starve calls. Revisit after WP-L1 gives the real Mb/s and a host link figure. |
| Q2 | **How many simultaneous lives?** | **One at a time network-wide** in v1 (a second member sees "a live is already on"). Two lives double the egress for a school-sized audience. |
| Q3 | **Simulcast / quality.** | **No simulcast in v1**: one 720p-or-lower encoding at a fixed bitrate (start ~1.2 Mb/s video + Opus), portrait. Simulcast needs SFU layer selection that does not exist, and is worth it only past tens of viewers. Make it a later WP, decided by WP-L1's figures. |
| Q4 | **Who counts as a follower** for the push? | For a member: `user_follows`. For an association: `association_follows` **minus** `association_push_mutes`. Lives by a member broadcasting "as" an association use the association's followers. One push per live start, never on reconnect. |
| Q5 | **Safety rules for a school network** - are there minors, and is there an age rule? | Ask the School whether any account can belong to a minor _(unverified: nothing here records it)_. Recommend: live only for accounts verified as School members, a short **first-live notice** with the rules, the broadcaster's name always shown, and staff alerted on every report against a live while it is running. |
| Q6 | **Apple / Google policy for live UGC.** | Apple's guideline 1.2 asks UGC apps for a way to filter, report and block, and published contact info; Google Play has a UGC policy of the same kind _(both unverified against today's text - read them during WP-L0)_. L6 already gives report and remote cut; add **viewer-side block of a broadcaster** (the existing block, applied to live cards) and say so in the review notes, with the video Apple asks for. |
| Q7 | **The SFU test bench.** | WP-L1: a headless publisher + N headless subscribers on the LOCAL estate, **1 then 30 viewers**, measuring SFU CPU and RSS, TURN bytes, end-to-end latency and keyframe recovery; then the same 30 against **dev**, never prod. A green build proves nothing about this. |
| Q8 | **The key design** (key in the row, rotation when a viewer is removed). | A random 32-byte **live key** in the live row, served like a post CEK to any member (L2). It protects against the storage and the SFU, **not against a removed viewer**, who already holds it and could re-read the row. So: a removed viewer is enforced **by the server** (room token refused, SFU drops the peer), and rotation is NOT the mechanism; state that limit plainly rather than rotating a key every member can fetch. |
| Q9 | **The broadcaster's network drops.** | A **reconnect window of 60 s** _(a number to confirm on the bench)_: viewers see "reconnecting", the room is held, the live ends if the broadcaster does not return. The end is a DURABLE state change on the row (`ended_at`), not a timer on the clients. |
| Q10 | **Background and screen lock on phones.** | The broadcaster's camera stops when the app leaves the foreground on both platforms _(unverified on our builds)_; treat it as a drop (Q9) and say so on screen. A viewer going to background just leaves. No background modes are added for live - they are what App Review refused once. |
| Q11 | **TURN usage.** | Today viewers do NOT pull from the SFU: everything crosses TURN (above). Either accept that and budget it (Q1), or ask the DSI for an inbound UDP range so viewers reach the SFU directly and TURN serves only those who need it. Recommend: ask the DSI in the same request as the calls revival, since calls need it too. |
| Q12 | **What does the broadcaster's local save record?** | Its own camera and mic only, via `MediaRecorder`, to the gallery (the C6 save path), never the chat. Confirm. |
| Q13 | **Can a live be scheduled / shown as "upcoming"?** | Not in v1. |

## The work packages, in order

Each starts from a named point and ends on a test that would fail without it.

| WP | What | Starting point | Done when |
| --- | --- | --- | --- |
| **WP-L0** | **Calls revival**: the five switches in one commit, the SIXTH (no names in a silent invite) and the SEVENTH (`none` level vs. a ring) decided, rung 15 CALL + CALL-13 on real hardware, the by-hand relay-path call, then **the screen recording App Review asks for**. | `frontend/src/lib/features.ts` `CALLS_ENABLED` and the switch table in [calls](calls.md) | the board rows `PASS`; the video recorded; a build accepted with calls on |
| **WP-L1** | **SFU one-to-many bench**: a test harness, one publisher, then 1 and 30 subscribers, numbers recorded on this page. | `apps/call-service/tests/relay_path.rs` (extend it beyond two peers) | measured Mb/s per viewer, TURN GB per live-hour, SFU CPU/RSS at 30 viewers |
| **WP-L2** | **Roles in the SFU**: a `broadcast` room kind where only the broadcaster may publish, viewers are receive-only, no fan-out between viewers, a viewer cap, and a server-side **kick**. Decide here whether this lands on webrtc 0.17 or after the 0.20 port. | `main.rs` `on_track` and `handle_signal` `Join` | Rust tests: a viewer's track is refused; the cap refuses viewer 31; a kicked peer is closed and cannot rejoin |
| **WP-L3** | **The live row and its key**: a `lives` record (broadcaster, as-association, key, `started_at`, `ended_at`), a live room token minted for any member (not a group check), removed-viewer list. | social-service posts / reels server ([reels (server)](../../services/reels.md)) | API tests: token refused after `ended_at` or for a removed viewer; key served as a post CEK |
| **WP-L4** | **Frame E2E from the row key**: `RTCRtpScriptTransform` keyed by the live key, **no cleartext path**. | `CallService.ts` `setupEncryption`, `workers/encryption.worker.ts` | unit test that a missing transform refuses to broadcast; bench viewer decodes |
| **WP-L5** | **Broadcaster and viewer UI**: composer "Live" entry, broadcast screen, viewer screen, reconnect state (Q9). | the composer ([posts](posts.md)) and camera ([reels](reels.md)) | e2e on two browser contexts; phone readings on Mi 9T and iPhone 12 |
| **WP-L6** | **Live chat and floating reactions**, encrypted with the live key, ephemeral (gone with the live). | the WS gateway ([chat-gateway](../../services/chat-gateway.md)) | tests: messages unreadable without the key; nothing persisted after `ended_at` |
| **WP-L7** | **Announcement**: LIVE card at the top of the feed; push to followers (Q4). | the feed, `PostNotificationsService` | tests on the follower set incl. mutes; one push per live |
| **WP-L8** | **Moderation**: hide message, remove viewer, report a live, staff remote cut. | `content_reports`, [moderation-and-blocking](../../moderation-and-blocking.md) | tests: a cut ends the room and the row; a report reaches staff while live |
| **WP-L9** | **Store review**: UGC answers (Q6), the review video for live, then a pre-release to testers. | [mobile](../mobile.md) submission notes | accepted builds on both stores |

## See also

- [calls](calls.md) - the switches and why calls are held off
- [call-service](../../services/call-service.md) - the SFU
- [reels](reels.md) - the chantier this is stage R4 of
- [backlog](../../backlog.md) - the calls-held-off items
