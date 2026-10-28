# Calls - the revival plan (DRAFT, 2026-10-15, not started)

> **Lot 1 BUILT 2026-10-17 (WP-C1a and part of WP-C3):** the P2P mode in `CallService.ts` and the
> two-person relay in `call-service`, `iceTransportPolicy: 'all'`, E2E refused rather than degraded,
> in-app 1:1 audio on DEV builds only. What was verified and what is owed (devices, dev TURN keys):
> [calls lot 1](calls.md#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only). WP-C1's Tier A
> runs on it next.
>
> **Decisions 2026-10-18 (the user), recorded on [calls](calls.md#the-users-decisions-of-2026-10-18):**
> (6) the caller's name on a silent ring comes from the phone's LOCAL copy, never the payload, and an
> unknown caller shows the neutral "Canari call"; (ICE) `iceTransportPolicy` stays `'all'`, direct
> first, TURN as the fallback; (block) no call crosses a block, also inside an existing conversation
> (`403 USER_BLOCKED`, neutral); (7) calls get their OWN per-conversation permission, independent of
> the notification level - BUILT 2026-10-18
> ([call permission](calls.md#the-call-permission---its-own-setting-per-conversation-decided-2026-10-18)).
>
> **Note 2026-10-17:** the user's 2026-10-16 decisions supersede parts of this plan: 1:1 calls go peer-to-peer DIRECT with Cloudflare TURN as the fallback (not relay-only through the SFU), and `1.2.9` ships without #1955. Where the sections below assume "both ends relay-only" or an SFU for 1:1, read them as the 2026-10-15 state, to be re-planned.

> **Status: a plan, nothing built.** Calling is held off since 0.14.15 (`CALLS_ENABLED = false`,
> [calls](calls.md)). This page orders the work that brings it back, **cheapest decisive test
> first**, and names what each step depends on. Every statement marked **(unverified)** was not read
> in code or measured; everything else was read from `origin/main` on 2026-10-15.
>
> **Host feasibility is measured by a separate piece of work** and lands as
> `docs/wiki/infrastructure/realtime-media-feasibility.md` (branch `docs/realtime-media-feasibility`,
> not merged when this was written - turn this mention into a link once it is). This plan never
> assumes its answers: each work package says which finding (`F1`..`F7`, defined below) it waits on.
> No host command was run to write this page.

## 1. Why calls stopped, and what the user said unblocks them

- **Calls never ran.** Twenty CALL rows (rung 15) on the [board](../../cross-client-testing.md) are
  `pending`; the SFU has never opened a peer connection in production; no iPhone ever registered a
  PushKit token. App Review refused the `voip` background mode under 2.5.4 on 2026-08-31 for a VoIP
  service it could not find ([mobile](../mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on)).
- **The user, 2026-10-15** (decision L7 of the live plan, `docs/wiki/frontend/modules/live.md`, PR
  #1924): revive calls BEFORE live; what mostly blocked calls is that **Apple App Review needs a VIDEO
  recording showing everything works**, on top of our own tests. And: **the host has FEW open ports to
  the outside, so what is feasible must be TESTED NOW, early** - before anything is built.
- **And: "test calls with EVERY possible configuration - PC, Android, iPhone; you have everything at
  hand"** (relayed 2026-10-15). Section 7 is that matrix.

## 2. What exists, read from the code

### The media path - and why "few open ports" may not matter

```
client (browser / WebView)                    host (canari-prod)
  iceTransportPolicy: 'relay'                   call-service (Rust, webrtc 0.17)
  ICE servers from GET /api/calls/ice-servers   RTCIceTransportPolicy::Relay when a TURN URL exists
        |                                              |
        | TURN (udp 3478 / tcp / tls 443)              | TURN over UDP ONLY (filter_urls_for_sfu drops
        v                                              v  tcp, :53, :80, :443)
              Cloudflare TURN (rtc.live.cloudflare.com credentials)
                    relay <-------------------> relay
signalling: wss://<origin>/api/call -> nginx -> call-service:3004/ws  (Join/Offer/Answer/IceCandidate)
ring/invite: MLS SystemMsg over chat-gateway + POST /api/calls/ring (FCM data / APNs VoIP)
```

- **Both ends are relay-only** (`CallService.ts` `initPeerConnection`, `iceTransportPolicy: 'relay'`;
  `apps/call-service/src/main.rs` ~L1795). So, by construction, **the host needs NO inbound media
  port**: the SFU's only media traffic is OUTBOUND UDP to Cloudflare TURN and its replies. Whether the
  host's firewall lets that out is finding **F1** - the single most decisive fact for this plan.
- **The client keeps every Cloudflare URL except port 53** (`calls.service.ts` `filterIceServers`), so a
  client on a UDP-blocked network can still reach TURN over TCP/TLS 443 **(unverified: which URLs
  Cloudflare actually returns today)**. The SFU cannot (webrtc-rs is TURN/UDP only here).
- **Every media byte crosses the host's uplink once per subscribed stream**, and Cloudflare TURN once
  per leg on each side. TURN spend is capped by `CLOUDFLARE_TURN_MONTHLY_BUDGET_GB` (950) against an
  ESTIMATE (`CALL_RELAY_KBPS_PER_DEVICE`, 3000 kbps x duration, counted on presence clear) - an
  estimate, not Cloudflare's byte count. **Replaced 2026-10-21 (B7):** the budget now reads
  Cloudflare's metered egress ([calls](calls.md#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21)).
- **Signalling to the SFU rides the existing HTTPS origin** (`/api/call` in
  `infrastructure/local/Dockerfile.frontend`, rewritten to `/ws`), so it adds no port; whether a
  30-minute WebSocket survives the edge (Cloudflare tunnel, the DSI's CrowdSec) is **F4**.

### What the code has

| Area | Where | State |
| --- | --- | --- |
| Client call engine | `frontend/src/lib/services/CallService.ts` (1297 lines) | complete for 1:1; held off by `CALLS_ENABLED` |
| Call UI | `frontend/src/lib/components/chat/CallOverlay.svelte` (931 lines) | exists; shows an E2E badge from `e2eActive` |
| E2E frames | `frontend/src/lib/workers/encryption.worker.ts` + `CallService.setupEncryption` | one key per direction since 2026-10-21 = `exportSecret(groupId, 'mls-webrtc-media-v2', '<callId>\|<sender role>', 32)` (`utils/callKeys.ts`), AES-GCM with `canari-call-v2\|<kind>` (+ the VP8 clear header) as additional data (`utils/callFrameAad.ts`), random 12-byte IV ([calls](calls.md#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only)) |
| Audio tuning | `frontend/src/lib/utils/callAudio.ts` | sender params per call kind |
| Missed-call message | `frontend/src/lib/utils/chat/callSystemMessages.ts` (`recordCallMissed`) | a timeline system message; no call-history screen exists |
| Failure type | `frontend/src/lib/utils/callFailure.ts` | `CallInitiateError` |
| Room/ICE/ring API | `apps/chat-delivery-service/src/services/calls.service.ts`, `controllers/calls.controller.ts` | room token HS256 5 min; ICE via Cloudflare; ring fan-out FCM + direct APNs VoIP |
| SFU | `apps/call-service/src/main.rs` (1952 lines), `tests/relay_path.rs` | webrtc 0.17, axum 0.8; relay-path data+SRTP test in CI, no SFU call ever placed |
| Android ring | `CanariFirebaseMessagingService.kt` | CallStyle + full-screen intent, gated `CALLS_ENABLED = false` |
| iOS ring | `canari_push.mm` (PushKit/CallKit, `kCanariCallsEnabled`), `canari_NSE/NotificationService.swift` | gated off; `voip` removed from `UIBackgroundModes` |
| Call record (SFU) | `[call] session end ... disposition=...` | exists, pinned by tests ([call-service](../../services/call-service.md#the-call-record)) |

### What the code does NOT have, or gets wrong (read, not run)

1. **Group calls cannot show more than one remote participant.** `handleRemoteTrack` merges every
   remote track into ONE `mergedRemoteStream` and **removes any older track of the same kind** ("drop
   stale tracks"); `publishRemoteStream` publishes `Map([['remote', stream]])`. With three people, the
   second remote audio replaces the first. Group calling is a client rebuild, not a test.
2. **The E2E path is asymmetric on an engine without `RTCRtpScriptTransform`.** `attachMediaTransforms`
   returns early ("E2E disabled") and `initPeerConnection` attaches a sender transform only when
   `RTCRtpScriptTransform` exists - yet `handleRemoteTrack` still calls `setupReceiverTransform`, which
   falls back to `createEncodedStreams` and DECRYPTS. Such a client would send cleartext and try to
   decrypt what it receives. Which shipped engines lack `RTCRtpScriptTransform` (Android System
   WebView, older Chrome) is **(unverified)**.
3. **"E2E disabled" is a degrade-and-continue path** (`e2eActive=false`, a badge, the call proceeds).
   Under [the rule](../../durable-rules.md) a fallback is a signal, never a path: the revival must
   decide refuse-or-accuse (WP-C3).
4. **The whole frame is encrypted, header included.** That is known to be fine for Opus and VP8 in
   Chromium, and known to break H.264 packetization, which needs NAL headers in clear **(unverified for
   this code - no H.264 call was ever placed; Safari/WKWebView may negotiate H.264)**.
5. **One key per call, never rotated.** A member removed from the MLS group mid-call keeps the media
   key until hangup; a joiner after a commit derives from a different epoch **(unverified: whether both
   sides always derive at the same epoch)**.
6. **A failed decrypt drops the frame and logs to `console.error`**, not to `appendLog`, so a phone's
   exported log would not show it.
7. **No call-quality report.** Nothing reads `RTCPeerConnection.getStats()`: no selected candidate
   pair, no bitrate, loss, jitter or audio level is ever logged on the client.
8. **No ICE restart.** A network change (Wi-Fi -> 4G) ends the call (CALL-16 says so by design).
9. **No screen share** (`getDisplayMedia` appears nowhere).
10. **iOS: no `audio` background mode**, and `NSMicrophoneUsageDescription` /
    `NSCameraUsageDescription` mention voice messages and reels, not calls.
11. **Android: no foreground-service type for a call** (`phoneCall` / `microphone`), no
    `BLUETOOTH_CONNECT`; capture in the background is therefore **(unverified)** at best.
12. **The `calls.md` "Key components" table named files that do not exist** (`CallUI.svelte`,
    `IncomingCallOverlay.svelte`, `CallNotificationService.ts`...); corrected there in the same commit
    as this page.
13. Carried from [calls](calls.md): the push payload no longer carries `senderName`/`groupName` on a
    silent frame (the ring banner would be untitled), and a conversation at notification level `none`
    sends the MLS invite silent. Both decided 2026-10-18: the name from the phone's local copy, and a
    per-conversation call permission ([calls](calls.md#the-users-decisions-of-2026-10-18)).

## 3. Goals and non-goals

| | In the revival | Later (own WP) | Not planned |
| --- | --- | --- | --- |
| 1:1 audio | **yes** | | |
| 1:1 video | **yes** | | |
| Group call (3+) | | WP-C11 (client rebuild, item 1 above) | |
| Screen share | | WP-C12, desktop only | phones |
| Call continues screen-locked / in background | **yes on Android**; iOS decided by WP-C6's spike | | |
| Incoming ring, app killed | **yes, both OS** (CallStyle FSI / CallKit) | | |
| Missed calls / call history | missed-call message (exists) + a history list | | |
| Permission strings mentioning calls | **yes** | | |
| E2E media keyed from MLS `exportSecret` via `RTCRtpScriptTransform` | **yes, mandatory, refused when absent** | key rotation on membership change | |
| Rejoin after a network change | | WP-C10 (ICE restart) | |
| Recording a call | | | **never** (E2E) |
| Calls in community salons | | | refused by design (CALL-14) |

**Fallback behaviour, stated once:** an unsupported transform, a missing TURN relay, a STUN-only SFU,
an estimated-budget refusal - each is a **logged signal at a level that accuses, with the evidence**,
and the call either refuses with a typed error or proceeds as designed. None is a silent second path.

## 4. The findings this plan waits on

The feasibility page may number them differently; map them when it lands.

| ID | Question | Decides |
| --- | --- | --- |
| **F1** | Can the host send UDP to Cloudflare TURN (3478 and the relay range) and receive the replies? | whether the current architecture works AT ALL on this host |
| **F2** | Can ANY inbound UDP port be opened by the DSI (one port is enough for an ICE-lite / single-port SFU)? | whether TURN can be skipped on the host leg (budget, latency) |
| **F3** | The host's real uplink and what share the DSI tolerates | the concurrent-stream ceiling; group size; live |
| **F4** | Does a 30+ min WebSocket to `/api/call` survive the edge (tunnel, CrowdSec, idle timeouts)? | signalling stability |
| **F5** | From each client network (home Wi-Fi, 4G, campus Wi-Fi, UDP-blocked), which TURN transport works? | whether clients need TURN/TLS 443 |
| **F6** | RTT host <-> nearest Cloudflare PoP | the latency floor of every call |
| **F7** | CPU headroom on the shared host under N forwarded streams | SFU sizing |

## 5. The six-webrtc-majors question

The SFU runs `webrtc = "0.17"`; it was 0.11 when last designed, and 0.20 is a re-foundation
([calls](calls.md#the-webrtc-020-port-measured-2026-09-15)). Nothing has placed a call on 0.17.

**What to test (WP-C1 does it, by hand):** relay-only ICE to Cloudflare from the SFU (the
`ErrNoTurnCredentials` rule); DTLS handshake against Chrome, Android WebView and WKWebView **(unverified:
whether current Chrome offers DTLS 1.3 first and how 0.17 answers)**; SRTP profile agreement; Opus both
ways; VP8 and H.264 video; RTCP PLI relay (`[keyframe]` lines); the renegotiation path (audio call ->
camera on, `schedule_renegotiate`); `close()` on every exit path (`session end` record and Cloudflare
allocation released).

**What to pin:** `webrtc = "=0.17.<n>"` exact in `apps/call-service/Cargo.toml` once a call passes, so
"the version that placed a call" is one version; keep the 0.20 refusal in
`.github/scripts/lib/ceiling.sh`; record the browser/WebView/iOS versions in every call report (WP-C2),
because the other half of the pair moves weekly.

**The decision it feeds (WP-C4):** keep the Rust SFU on 0.17, port it to 0.20, or move media to a
managed SFU (Cloudflare Realtime SFU; LiveKit self-hosted needs inbound ports, see F2). A managed SFU
takes the media off the host's uplink entirely - which F1/F3 may make the only option - at a cost per
GB beyond the free tier **(unverified: current Cloudflare pricing)**. E2E is unaffected by the choice
(the SFU forwards opaque frames either way).

## 6. Observability - a call report that carries evidence

**WP-C2 is BUILT** (draft #2011 of 2026-10-18, PORTED onto `main` 2026-10-21; it runs wherever
`CALLS_ENABLED` is true, today the `development` deploy; **owed one reading from a phone's exported
log**). One `[CALL_REPORT]` line per call per device, through `appendLog` (so the in-app log export
carries it), every 10 s while `incall` and once at the end, built by `buildCallReport`
(`frontend/src/lib/utils/callStats.ts`; tests in `callStats.test.ts` and `CallService.p2p.test.ts`):

```
[CALL_REPORT] call=<roomId> phase=<tick|end> dur_ms= setup_ms=<tap->first remote audio> engine=<[tauri-<shell>/]Chrome/N|Safari/N|iOS/N|Firefox/N>
  ice=<state> pair=<local type>/<proto>-><remote type>/<proto> relayed=<yes|no> [relay_proto=] [rtt_ms=] turn=<host:port, no credential>
  out_kbps= in_kbps= loss_in_pct= jitter_ms= audio_level_out= audio_level_in=
  e2e=<on|-> enc_frames= dec_frames= dec_fail= keyframes_in= codec_a= codec_v=
[CALL_REPORT] call=<roomId|-> phase=refused engine= e2e=refused reason=no-rtp-script-transform
```

- A field the stats do not carry is `-`, never guessed. Rates are computed between two readings on
  the stats' OWN timestamps, never a wall clock; a rebuilt peer connection restarts them.
- `engine=` is the E2E worker report's name for the engine (`engineFromUserAgent`), so the two lines
  of one call name it the same way.
- The E2E fields are the worker's EXACT totals, asked through the same bounded `report` request as
  the path check (`askE2eReport`), not the sampled progress lines. `dec_fail` = AES-GCM failures +
  NON-empty frames too short to be ours (a peer sending in clear); empty frames are not failures
  (Chrome hands a few to every receiver). `e2e=on` only when the worker answered; otherwise `e2e=-`
  and the worker's silence has its own ERROR line. The worker's transform errors now reach the call
  log, sampled (first 3, then every 100th), instead of a worker console nothing exports.
- Each tick is armed when the previous one was WRITTEN, so two never overlap. The END report is
  stamped and READ at the hangup, while the peer connection and the worker are still alive (cleanup
  releases them when the 1.5 s summary closes), and WRITTEN after a tick still in flight, so no tick
  line follows it. Nothing waits on it: teardown is unchanged, and a read that fails says
  `WARN call report (end) not written`. A call that never built a peer connection writes none.

- `call=` is the room id, the same value as the SFU's `room=` - the only join key between the halves
  ([call-service](../../services/call-service.md#the-join-key)). Keep it one value.
- `setup_ms` and `audio_level_in > 0` are the two numbers a "the call connected but nobody heard
  anything" report needs; `dec_fail` with `dec_frames=0` separates an E2E key mismatch from no media.
- No SDP, no candidate string, no credential, no name in the line (the in-app log is exported).
- Server side: `[ring] rang=N/M`, `[call] ice connected after_ms=`, `session end disposition=` exist;
  add the client's `setup_ms` nowhere else - the two are joined by `room=`, never duplicated.

## 7. The test matrix

**Endpoints.** The Pixel 6a is the user's personal phone and is **NEVER a test device** (user,
2026-10-11) - no install, no sign-in, no driving it, not even as a hotspot.

| ID | Endpoint | Driven by |
| --- | --- | --- |
| E1 | Chrome desktop, this Windows PC (two isolated contexts = two devices) | cross-client harness (`tools/cross-client-harness`, W1/W2 profiles) |
| E2 | Edge desktop, this PC | chrome-devtools MCP (CDP) |
| E3 | Firefox desktop, this PC (if installed; `RTCRtpScriptTransform` standard path) | by hand / CDP-less, read via the in-app log |
| E4 | Mi 9T, Android app (debug APK with the local flip) | android-mcp + `adb`/CDP over `chrome://inspect` (`tools/cross-client-harness/a1.py`, `a1apk.mjs`) |
| E5 | Mi 9T, Chrome browser on the web origin | android-mcp + CDP |
| E6 | iPhone 12, iOS app (TestFlight or `tools/ios-device/sign-install.mjs` build) | `tools/ios-device` (WDA daemon, `ios.mjs`) |
| E7 | iPhone 12, Safari on the web origin (the only WebKit we have; no Safari on Windows) | `tools/ios-device` |

**Networks.**

| ID | Network | How it is produced |
| --- | --- | --- |
| N1 | Both on the same Wi-Fi | the bench LAN |
| N2 | One Wi-Fi, one 4G | phone Wi-Fi off (`adb shell svc wifi disable` on the Mi 9T; Control Center on the iPhone) - **needs a SIM with data in that phone (unverified for both bench phones; ask the user)** |
| N3 | Both 4G | two SIMs, or one phone 4G + the PC tethered to a hotspot that is NOT the Pixel 6a |
| N4 | Campus Wi-Fi (school network) | a human on campus - the user, by appointment |
| N5 | UDP blocked | PC only: a Windows Firewall outbound rule blocking UDP for the browser (reproducible); phones only if a UDP-blocking network is found **(unverified)** |
| N6 | Through a VPN | PC VPN client, if one is available **(unverified)** |
| N7 | Network change mid-call (Wi-Fi -> 4G) | Wi-Fi switched off during a call on the phone |

**Call kinds.**

| ID | Kind |
| --- | --- |
| K1 | 1:1 audio |
| K2 | 1:1 video (both streams, E2E on) |
| K3 | Audio start -> camera on (renegotiation) |
| K4 | Group of 3+ (only after WP-C11) |
| K5 | Screen share, desktop (only after WP-C12) |
| K6 | Screen locked / app backgrounded mid-call, both phones |
| K7 | Incoming ring on a KILLED app (FCM FSI / CallKit) |
| K8 | Incoming ring on the lock screen, answered |
| K9 | A message arrives during a call (no notification storm, call unaffected) |
| K10 | Audio route switch: speaker / earpiece / Bluetooth headset (Bluetooth needs a headset - **unverified that one is on the bench**) |
| K11 | Rejoin after a network change (N7; ENDS the call until WP-C10) |
| K12 | Decline / cancel / unanswered 60 s / second call while busy (CALL-4, -5, -7, -17) |

**Observables, every cell:** ICE selected pair type and transport, `setup_ms`, in/out bitrate, inbound
loss, audio level both ways (non-zero), E2E `dec_frames > 0` and `dec_fail = 0`, the SFU `session end`
disposition (`client-close` or `sibling-evicted` only). Until WP-C2 lands, WP-C1 reads the same from a
local-only `getStats` dump and `chrome://webrtc-internals`.

**The cells, tiered - the full cross product (7 x 7 x 12) is not the bar; these are.**

| Tier | Cells | Gate |
| --- | --- | --- |
| **A - decisive, before anything is built** | K1 on: E1<->E1 N1; E4<->E1 N1; E4<->E1 N2 (Mi 9T on 4G); E6<->E1 N1; E6<->E4 N2 | WP-C1 exit; feeds the C4 decision |
| **B - before an alpha with the switch on** | K1, K2, K3, K9, K12 on every endpoint pair among E1, E4, E6 over N1 and N2; K1 on E2, E5, E7; K1 on E1 under N5; K6 and K7 on E4; K6, K7, K8 on E6 | WP-C8 |
| **C - before a stable** | Tier B over N3 and N4; K8 on E4; K10 on both phones; K11 on both phones; E3 and N6 if available; K4 and K5 once built | WP-C8, rows re-run on the stable's alpha |

**Who runs what.** The lead agent runs E1/E2 cells through the harness and chrome-devtools MCP; an
android-mcp-driving agent runs E4/E5; an agent on `tools/ios-device` runs E6/E7 (both bench phones are
the agents' sandbox, PINs included). **The user** runs what needs a body or a place: N4 (campus),
inserting or lending a SIM for N2/N3, the Bluetooth headset, and K8 if the lock-screen answer needs a
face/PIN the WDA cannot type. Every cell writes its verdict to the board's CALL rows
([cross-client-testing](../../cross-client-testing.md)), the bar is `PASS`, never `PASS-DIRTY`, and the
logs of both ends AND the SFU are read on every pass.

**The Apple video is recorded FROM these runs**, not staged afterwards: the Tier B iPhone cells (K1,
K2, K7, K8) are screen-recorded on the iPhone while they run, so the video shows a call that was also
measured (section 8).

## 8. The Apple App Review video, and the store and privacy impacts

**Why:** re-declaring `voip` (and `audio`) in `UIBackgroundModes` without proof is how 0.14.14 was
refused. The submission must carry a **screen recording of the feature working on a physical iPhone**
and review notes saying how to reach it **(unverified: whether Apple attaches it under App Review
Information or wants a link; both have been used)**.

**Shot list** (one take each, iPhone 12 on the release-candidate build, the Mi 9T as the other party):

1. Cold start, sign in with the review demo account, open a DM with the second account.
2. Tap the audio call button; the microphone permission prompt appears **with a string naming calls**;
   allow.
3. The Mi 9T rings and answers; both sides speak; the in-call screen shows the timer and the E2E badge.
4. Turn the camera on mid-call (K3); both videos render; turn it off; hang up from the iPhone.
5. **The iPhone app is killed** (swipe away on camera). The Mi 9T calls. **CallKit rings on the lock
   screen**; answer; unlock; the call is live in the app. This is the shot 2.5.4 needs - film it with the
   Mi 9T's camera pointed at the iPhone if the iPhone's own screen recording does not capture the lock
   screen **(unverified)**.
6. A second call is declined from CallKit; a third goes unanswered -> the missed-call message in the DM.
7. From the conversation, show **report** and **block** (guideline 1.2: a way to report and block
   abusive users exists for UGC; calling a blocked user must not ring - **built 2026-10-18**:
   `initiate` refuses a call across a block, so nothing rings ([calls](calls.md#the-switches-agree-and-a-silent-frame-stays-unread))).

**Review notes:** two demo accounts are needed (a reviewer cannot call themselves); either the reviewer
gets both credentials and two devices are assumed, or a staffed window is offered. A bot that answers
calls would need MLS membership and is not proposed.

**Store and privacy labels (to decide in WP-C9, not decided here):**

| Item | Impact |
| --- | --- |
| App Store privacy label - Audio Data, Photos or Videos | media is E2E and never stored; whether that is "not collected" under Apple's definition is **(unverified)** |
| Call metadata (who called whom, duration, IP to Cloudflare TURN) | the SFU and chat-delivery logs hold user ids, room ids, durations; Cloudflare sees IPs. Likely "Usage Data / Product Interaction" linked to identity - decide, and say it in the privacy policy ([store-listings](../../store-listings.md)) |
| Google Play - `USE_FULL_SCREEN_INTENT` | Android 14+ grants it by default only to calling/alarm apps; Play asks for a declaration **(unverified: current form)**; `callsCompiled.test.ts` asserts it present exactly when `CALLS_NATIVE_RING_COMPILED` is true (the native ring's own switch since 2026-10-21, B2') |
| Google Play - foreground service `phoneCall`/`microphone` | needs a declaration and, per Play's form, a video **(unverified)** - record it from the Tier B Mi 9T cells like the Apple one |
| Info.plist strings | microphone and camera strings must name calls; they are French literals in `Info.plist` today, not Paraglide |

## 9. Rollout - a server-side switch instead of five code switches (proposal)

**Written when** five switches moved in one commit. **Since 2026-10-21 (B2') they are two groups**
([calls](calls.md)): `CALLS_COMPILED` carries the in-app call (the plist's `audio`, the microphone
purpose strings, the Android microphone foreground service), and `CALLS_NATIVE_RING_COMPILED` carries
the native ring (the Kotlin and ObjC constants, `voip`, `USE_FULL_SCREEN_INTENT`), which the first
production calls ship WITHOUT. The two store declarations cannot be runtime
switches - a store reads the binary - but everything ELSE can.

**Proposal:**

1. **One compile-time fact, `CALLS_COMPILED`**, still in `frontend/src/lib/features.ts`, mirrored in
   Kotlin and ObjC with ONE agreement test - **built 2026-10-18**: `callsCompiled.test.ts` asserts
   Kotlin, ObjC, plist, manifest and the microphone purpose string against it
   ([calls](calls.md#the-switches-agree-and-a-silent-frame-stays-unread)). It says "this binary carries the declarations".
2. **One runtime mode, server-owned: `platform_config.calls_mode` = `off | testers | on`**, next to
   `maintenance_enabled` and `min_client_version` (`apps/core-service/src/platform/entities/platform-config.entity.ts`),
   served with them in `/api/version` (read by `frontend/src/lib/utils/appVersion.ts`), changed from the
   admin platform page. `testers` = pre-release builds only (the hyphen in the version, the same
   definition `release_kind()` uses), so TestFlight and Play testers get calls while store users do not.
3. **The SERVER enforces it** - `/api/calls/initiate`, `/ring`, `/room-token` refuse with a typed
   403-class answer when the mode excludes the caller - so a killed phone is never rung when the mode is
   `off`, whatever build it runs. The client reads the mode only to hide the buttons.
4. **A kill in production is then one admin action**, not a release through two stores.

Cost: a schema migration on `platform_config` (a data migration - waits for the user's yes), and the
store declarations still ship in every binary from the first `CALLS_COMPILED = true` build on, so the
App Store submission of that build must carry the video even if the mode is `off` for store users
**(unverified: whether App Review accepts a declared-but-server-disabled VoIP feature; it did not on
0.14.14 - so the safest order is to turn the mode `on` for the review build's lifetime)**.

**Sequence:** local flip (WP-C1) -> alpha with `CALLS_COMPILED = true` and mode `testers` -> Tier B
green -> stable submission with the video, mode `on` -> Tier C on the stable's alpha.

## 10. The work packages, in order

Owner profile follows [the subagent rule](../../durable-rules.md): **opus** for native, MLS/crypto,
migrations and the adversarial reviews; **sonnet** for mechanical work.

| WP | What | Starting point | Tests | Owner | Depends on | Exit criterion |
| --- | --- | --- | --- | --- | --- | --- |
| **WP-C0** | **TURN reachability probe, no SFU, no app code**: a throwaway page fetches credentials from dev's `/api/calls/ice-servers` and gathers relay candidates per URL (udp/tcp/tls), then a relay-only loopback | a scratch HTML page + `apps/chat-delivery-service/src/services/calls.service.ts` `getIceServers` (read only) | run on E1, E4, E5, E6, E7 over N1, N2, N5 | sonnet + the user for SIMs | F1 (for the SFU half only) | a table: endpoint x network -> which TURN transport yields a relay candidate, and its RTT. **An hour of work that decides F5 before anything is built** |
| **WP-C1** | **The decisive call, by hand, on dev**: `CALLS_ENABLED` flipped in the LOCAL tree only, a local-only `getStats` dump, Tier A cells (K1, then K2/K3) | `frontend/src/lib/features.ts`, `CallService.ts` `initPeerConnection`; dev's `call-service` logs | Tier A; read `[call] session end` and `ice connected after_ms=` on dev | opus (lead) | **F1, F4**; dev must have the Cloudflare TURN secrets **(unverified)** | Tier A all `PASS` with numbers, or the failing layer NAMED (TURN, DTLS, SFU, E2E). Answers section 5 for 0.17. Nothing committed but the page that records it |
| WP-C2 | The `[CALL_REPORT]` line (section 6) - **BUILT 2026-10-21 (port of #2011), owed the phone reading** | `CallService.ts` (new `callStats.ts` util beside `callAudio.ts`) | unit test on a fake `RTCStatsReport`; no wall clock | sonnet | - | the line on every exit path; read once from a phone's exported log |
| WP-C3 | E2E correctness: refuse instead of degrade; fix the asymmetric legacy path; header-in-clear framing per codec (VP8/H.264) or force VP8+Opus; decrypt failures into `appendLog` | `encryption.worker.ts`, `CallService.attachMediaTransforms` / `setupReceiverTransform` | worker unit tests per codec; K2 Chrome <-> WKWebView | opus + adversarial review | WP-C1 (which codecs actually negotiate) | `dec_fail = 0` on every Tier A/B video cell; no engine can join in clear |
| WP-C4 | **Decision**: keep Rust SFU 0.17 pinned / port to 0.20 / managed SFU | this page section 5, the feasibility page | - | the user, on the lead's recommendation | **F1, F2, F3, F7**, WP-C1 | a recorded decision; if "keep", `webrtc = "=0.17.n"` pinned |
| WP-C5 | Android: ring and background - FSI back + `canUseFullScreenIntent`, foreground service `phoneCall`, caller name from the device cache (not the payload; decided 2026-10-18, an unknown caller shows "Canari call"), the native `call_invite` branch honouring the per-conversation call permission, audio routing incl. Bluetooth | `CanariFirebaseMessagingService.kt`, `AndroidManifest.xml`, `androidFcmManifest.test.ts` | K6, K7, K8, K10 on E4; NOTIF rows unaffected | opus | WP-C1 | Tier B Android cells `PASS` |
| WP-C6 | iOS: **spike first** - does WKWebView keep capturing and playing with the screen locked under an active CallKit call, and can the answer reach a call while MLS sits behind the PIN? Then PushKit/CallKit, `voip` + `audio` modes, `AVAudioSession` handover | `canari_push.mm`, `canari_iOS/Info.plist`, `iosCallDeclarations.test.ts`, `stores/pendingCallAccept.ts` | K6, K7, K8 on E6 | opus | WP-C1 | spike verdict recorded; if WKWebView cannot, the user chooses: foreground-only calls without `voip`, or a native media path (a separate chantier) |
| WP-C7 | Call UX: history list from the call system messages, busy/second-call answer, ~~blocked users never ring~~ (built 2026-10-18), permission strings naming calls (asserted against `CALLS_COMPILED` since 2026-10-18; the text is written in the revival commit), ~~the ring obeying (or not) the conversation level~~ (decided and built 2026-10-18: the per-conversation call permission, [calls](calls.md#the-call-permission---its-own-setting-per-conversation-decided-2026-10-18)) | `callSystemMessages.ts`, `CallOverlay.svelte`, `calls.service.ts` ring fan-out, `messages/fr.json` / `en.json` | unit + K9, K12 | sonnet (strings, UI), opus review of the ring rule | - | CALL-4/5/7/17/18/19 `PASS` |
| WP-C8 | The campaign: rung 15 CALL-1..20 + the matrix tiers B then C, video recorded from the iPhone cells | [board](../../cross-client-testing.md), `tools/cross-client-harness/README.md` | the rows themselves | lead + device agents + the user for N4/SIM/headset | WP-C2..C7 | Tier B green on an alpha (mode `testers`); Tier C green before the stable |
| WP-C9 | Store: the Apple video + notes, privacy labels, Play FSI/FGS declarations, privacy policy text | this page section 8, `store/`, [store-listings](../../store-listings.md) | `submit.mjs --check-notes` | sonnet + the user (App Store Connect, Play Console are one-off clicks) | WP-C8 Tier B | the stable passes App Review with `voip` declared |
| WP-C10 | ICE restart on network change (K11) instead of ending the call | `CallService.ts` `onconnectionstatechange`, SFU renegotiation | K11 on both phones | opus | WP-C4 | Wi-Fi -> 4G keeps the call with a gap measured in `[CALL_REPORT]` |
| WP-C11 | Group calls: one stream per remote participant, tile grid, the SFU's per-peer subscription | `CallService.handleRemoteTrack` / `publishRemoteStream`, `CallOverlay.svelte`, `main.rs` room tracks | K4 with 3 then 5 legs | opus | **F3**, WP-C4 | 5-leg call `PASS`; host egress measured against F3 |
| WP-C12 | Screen share, desktop | `CallService` (`getDisplayMedia`, a second video sender) | K5 on E1/E2 | sonnet | WP-C11 | a shared tab readable at 1280 |
| WP-C13 | Server-side switch (section 9) | `platform-config.entity.ts`, `calls.service.ts` guards, `appVersion.ts`, admin platform page | controller specs per mode; client gate test | sonnet + opus review (migration) | the user's yes on the migration | `off` stops rings server-side, measured on E4 |

WP-C13 can be built in parallel with WP-C2..C7; it must be in place before the first alpha with
`CALLS_COMPILED = true`.

## 11. Risks

| Risk | Why it is credible | What surfaces it first |
| --- | --- | --- |
| **The host cannot reach Cloudflare TURN over UDP, or its uplink is too small / not ours to spend** | the whole design is relay-only through Cloudflare, and the host is the DSI's | F1, F3; WP-C1 |
| **iOS WKWebView cannot hold a call in the background or behind the lock screen, and the MLS key sits behind the PIN** | CallKit answer currently hands over on `didBecomeActive`; the audio session and capture belong to WebKit | WP-C6 spike |
| **The E2E transform is wrong on some engine** (H.264 whole-frame, asymmetric legacy path, no rotation) | read from code, never run across engines | WP-C1 K2 cells; WP-C3 |
| webrtc-rs 0.17 fails against a current browser (DTLS/SRTP/RTCP) | six majors never placed a call | WP-C1 Tier A |
| Campus Wi-Fi blocks UDP and Cloudflare TLS-443 is not offered or is slow | common on school networks **(unverified here)** | WP-C0 N5, N4 |
| TURN budget estimate (3000 kbps x duration) is wrong by a large factor | it is an estimate, not a byte count | `[CALL_REPORT]` out/in kbps vs Cloudflare's dashboard after Tier B |
| App Review refuses again despite the video | 2.5.4 was literal about the build tested | WP-C9; mode `on` for the review build |
| Play revokes FSI / refuses the FGS declaration | Android 14 policy | WP-C9 |

## 12. Other real-time features worth planning on the same SFU (PROPOSALS)

Ranked by value over cost; none is decided, each would get its own plan. The live plan (L1-L11,
`docs/wiki/frontend/modules/live.md`, PR #1924) is already decided to come AFTER calls.

1. **Live (the decided one)** - effort large, risk high: an uncapped audience conflicts with per-viewer
   TURN streams (L8); it depends on WP-C4's choice and F3 above all.
2. **Voice rooms / audio salons** (drop-in audio attached to a community salon, no ring) - effort
   medium, risk medium: reuses the SFU and the audio path, but needs WP-C11's multi-stream client and a
   key per salon epoch rather than per call; the user refused calls IN salons (CALL-14), so this is a
   new decision.
3. **Screen share** - effort small once WP-C11 exists, risk low (desktop only).
4. **Live reactions during a call or live** (floating emoji over a data channel or MLS app messages) -
   effort small, risk low; MLS app messages already carry reactions, so no SFU work.
5. **Walkie-talkie / push-to-talk in a DM** - effort medium, risk medium: the background-audio problem
   of WP-C6 again, with no CallKit to lean on.

## 13. What works with no port opened by the DSI (2026-10-16)

**F1 is answered, and it is NO**: the host cannot send UDP out, so the current design (both ends
relay-only, the Rust SFU on the host in the middle) cannot connect from production. **But the
clients CAN reach Cloudflare TURN over every transport** (PC and Mi 9T on Wi-Fi, measured), so
every path that keeps media OFF the host needs nothing from the DSI. The measurements, the four
paths and their costs are on [realtime-media-feasibility section 8](../../infrastructure/realtime-media-feasibility.md#8-what-works-with-no-port-opened-by-the-dsi-measured-2026-10-16),
the only copy. What it changes here:

- **1:1 (the revival's scope) goes PEER TO PEER**, Cloudflare TURN as the last resort, signalling
  over the existing `/api/call` WebSocket with `call-service` reduced to a relay of
  `Offer`/`Answer`/`IceCandidate` between the two room members. E2E is unchanged (the transform and
  the `exportSecret` key do not care what is on the other end). **A new WP-C1a precedes WP-C1**: the
  P2P mode in `CallService.ts` (`iceTransportPolicy`, polite/impolite roles) and the relay in
  `main.rs`; WP-C1's Tier A then runs on it. **Two decisions for the user** (the first taken 2026-10-18: `'all'` stays): `iceTransportPolicy:
  'all'` (a contact learns your public IP; direct calls cost nothing) or `'relay'` (every call through
  Cloudflare, IP hidden, billed); and whether the TURN estimator (`CALL_RELAY_KBPS_PER_DEVICE`) counts
  only calls whose `[CALL_REPORT]` `pair=` says `relay` - answered 2026-10-21 by neither: the
  estimator is deleted and the budget reads Cloudflare's meter ([calls](calls.md#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21)).
- **WP-C4 narrows to the GROUP question**: Cloudflare Realtime SFU (no DSI, no host uplink, TURN
  free with it, 1 000 GB/month free shared, a new app + two secrets) versus keeping the Rust SFU on
  the old `canari` VM (its UDP reaches Cloudflare, measured; but it is the documented rollback VM)
  versus the DSI rule. **The webrtc-rs TURN-over-TCP/TLS route is closed** - 0.20.5 skips non-UDP
  TURN URLs explicitly, as 0.17 did.
- **WP-C0 is half done**: reachability per transport is measured for PC and Mi 9T on home Wi-Fi.
  Owed: mobile data (no SIM in the Mi 9T), campus Wi-Fi, the iPhone (the probe page needs a public
  origin). A CREDENTIALED allocation is measured since (section 14, Q1). **Dev has no Cloudflare TURN pair**, so dev's
  `/api/calls/ice-servers` answers 503 until the user gives it one.
- **The DSI rule (UDP 3478 out from the host's egress address) is needed only if the Rust SFU stays on the host.**

## 14. Probes of 2026-10-16: clients

Measured from a standalone probe page (`canari-harness/probes-clients-2026-10-16/`, raw JSON and
notes, no credential) on the developer PC's home network (Chrome 155) and the Mi 9T on the same
Wi-Fi (Chrome 154, no SIM), signalling through a local mailbox. ICE servers were public STUN only
for Q2/Q3, and short-lived (2 h) Cloudflare TURN credentials from a probe key for Q1. The servers are
probed separately.

| Question | Result |
| --- | --- |
| Q1 - a CREDENTIALED Cloudflare TURN allocation | **All 12 allocate** (second pass, 14:10-14:20Z, a probe TURN key created with the user's authorisation and deleted after): relay-only gathering yields a relay candidate in 95-135 ms on the PC and 100-155 ms on the Mi 9T, over udp 3478, tcp 3478, tls 5349, tls 443, udp 443 and tcp 80, no `icecandidateerror` |
| Q1 - RTT and throughput through the relay, one device (two relay-only peers in one page, both legs through Cloudflare) | PC: udp 3478 RTT p50 22.6 ms, 33 Mbit/s; tcp 3478 21.2 ms, 15 Mbit/s; tls 5349 26.4 ms, 51 Mbit/s; tls 443 19.4 ms, 44 Mbit/s. Mi 9T: udp 3478 28.6 ms, 13 Mbit/s (its Wi-Fi carries both legs); tls 443 36.2 ms, throughput not captured. Connect 196-338 ms. One run each: an order of magnitude, not a ranking |
| Q1 - PC <-> Mi 9T, `iceTransportPolicy: 'relay'` through Cloudflare TURN | udp 3478: relay/relay pair, connected 427 ms, RTT p50 **34.5 ms** (19.6-250), **19.7 Mbit/s** over 21 s. tls 443: connected 452 ms, RTT p50 **35.5 ms** (23-266), **23.6 Mbit/s** over 23 s |
| Q2 - PC <-> Mi 9T, same Wi-Fi, `iceTransportPolicy: 'all'` | Connected in 1.7 s on a **host/host UDP** pair; data-channel RTT min 4.9 / p50 10.4 / max 133 ms (20 pings); **26 Mbit/s** over 11 s (one SCTP channel) |
| Q2 - same pair forced to `'relay'` | With STUN only: no relay candidate, ICE stays `new` (by construction). With TURN credentials: see Q1 |
| Q2 - one side on cellular | Not possible: the Mi 9T has no SIM, the iPhone was not reached (below) |
| Q3 - mesh, PC sends 720p at 1.5 Mbit/s to 2 receivers (Mi 9T + a Chrome tab) | Holds: each peer 1.45-1.6 Mbit/s, 24-30 fps, 1280x720, `qualityLimitationReason: none`, no loss; **one encode per receiver** (~3.7 ms/frame each); whole-PC CPU 13.2 % vs 9.1 % idle (Ryzen 7 7800X3D). The Mi 9T decoded 25-31 fps, 0 dropped |
| Q3 - the same mesh with the **Mi 9T as sender** | Each peer 1.2-1.9 Mbit/s but fps **dips to 18-23** every few seconds; encode 19-24 ms/frame **per receiver**; Chrome ~110 % of 800 % in `top`. Two receivers already strain a 2019 phone |
| Q4 - Cloudflare Realtime on the account | Read 2026-10-16 with the account-scoped stored token (the admin one still answers `10000`): **one TURN key, `canari-calls` (created 2026-05-26), with 0 bytes of usage in 30 days; NO SFU app; no SFU usage.** The only TURN usage in the window is the probe's own (~0.5 GB each way) |
| Q4 - SFU pricing (developers.cloudflare.com, page dated 2026-09-22) | $0.05/GB egress, first 1 000 GB/month free **shared** by SFU and TURN, ingress free, TURN<->SFU traffic "not charged twice" |
| Q4 - E2EE through the Cloudflare SFU | Only the RealtimeKit guide describes frame encryption (insertable streams / `RTCRtpScriptTransform`); nothing read states the raw SFU forwards transformed frames - **unverified**, the first thing WP-C4 must test |

What this changes:

- **A 1:1 call on one network goes direct and costs nothing**: host/host in under 2 s, ~10 ms, far
  more bandwidth than a call needs. **`'relay'` costs ~25 ms of RTT on the same network** (p50 34.5
  vs 10.4 ms) and still carries ~20 Mbit/s, far above a call, over UDP 3478 AND over TLS 443 - so the
  `'all'`/`'relay'` choice of section 13 is privacy against Cloudflare egress, not call quality.
- **A mesh live is a sender's-uplink AND a sender's-CPU problem**: every receiver is a separate
  encode. A desktop barely notices two; the Mi 9T already drops frames at two. A phone-hosted live
  past one or two viewers needs an SFU (one upload, one encode), which is the group question of
  WP-C4.
- **The production TURN key has never carried a byte** (30 days) - consistent with calls being held
  off, and a WP-C4 Cloudflare SFU would be a NEW app.
- **Owed, and what blocks each**: the relay over mobile data and campus Wi-Fi; the iPhone needs a
  page origin it can open (LAN serving is refused by this session's permission policy, and an
  Artifact frame refuses WebRTC); cellular needs the iPhone or a SIM in the Mi 9T.

## See also

- [calls](calls.md) - the module and the held-off state
- [call-service](../../services/call-service.md) - the SFU and its call record
- [chat-delivery calls](../../services/chat-delivery.md#calls) - room tokens, ICE, ring fan-out
- [mobile](../mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on) - the App Review letter
- [device-verification](../../device-verification.md) - the bench and its rules
- [backlog: calls held off](../../backlog.md#p3-blocked-calls-held-off---the-sfu-runs-six-webrtc-majors-it-has-never-placed-a-call-on-2026-08-27)
