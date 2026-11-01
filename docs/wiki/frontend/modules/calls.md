# Calls module

**Routes**: `src/routes/calls/` (if standalone)  
**Components**: `src/lib/components/calls/`, `src/lib/composables/useCallSession.svelte.ts`  
**Service**: `src/lib/services/CallService.ts`

> **STATE, 2026-10-31: IN-APP 1:1 AUDIO IS LIVE IN PRODUCTION; 1:1 VIDEO AND THE NATIVE RING RIDE
> 1.5.2 AND NO STABLE CARRIES THEM YET.**
>
> - **In-app audio, peer to peer: on.** `CALLS_COMPILED = true` (`frontend/src/lib/features.ts`)
>   since the flip PR (#2299, 2026-10-23); the first stable carrying it is `v1.5.0`. Production
>   runs `1.5.1` with the server's `calls_mode = audio` (owner, 2026-10-31) and has carried real
>   calls. [The flip](#turning-calls-on-in-production---audio-11-only-owner-2026-10-21).
> - **The server stays the kill switch.** `platform_config.calls_mode` is `off`, `audio` or
>   `audio_video`; clients hide every call control when it says `off`
>   ([B12](#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21)).
>   A dev build shows calls whatever the server says (`CALLS_ENABLED` also holds on `development`).
> - **Video: compiled, shut.** `CALLS_VIDEO_ENABLED = CALLS_ENABLED` since #2711 (first in
>   `v1.5.2-alpha.1`); production stays audio-only until `audio_video` is set, after its readings
>   pass - [turning video on](#turning-video-on-in-production---11-video-in-152-owner-2026-10-30).
> - **The native ring: compiled for 1.5.2, in no stable.** All five switches moved in ONE commit
>   (#2727, 2026-10-30; `CALLS_NATIVE_RING_COMPILED = true`; `callsCompiled.test.ts` asserts they
>   agree), so a closed or locked phone rings full screen once 1.5.2 ships -
>   [the native ring ships in 1.5.2](#the-native-ring-ships-in-152-owner-2026-10-30).
>
> **HISTORY - THE WHOLE SURFACE WAS HELD OFF FROM 0.14.15 TO 1.4.x** (`CALLS_ENABLED = false`). The
> code below the banner was kept, not deleted. The reason was that none of it had run: no CALL row
> of the campaign board had been executed, the SFU had never had a peer connection opened against
> it, and no iPhone had registered a PushKit token, so no CallKit ring was deliverable. App Review
> refused the `voip` background mode under guideline 2.5.4 on 2026-08-31 for a VoIP service it
> could not locate - correctly, on the build it tested. The plan that brought calls back is
> [calls-revival-plan](calls-revival-plan.md) (2026-10-15); the sections below hold each decision.
>
> **Three findings of that period still bind the code:**
>
> 1. **A silent push frame carries no `senderName` or `groupName` (2026-09-22).** Both are
>    unbounded user text, the payload is cleartext to FCM and to APNs, and nothing read them there.
>    A `call_invite` is a silent frame, so a call banner takes the name from the device's own
>    store or from an alert push - **never by restoring the fields**, which would put every
>    student's name back in front of Google on every read receipt.
>    ([push-payload](../../../../apps/chat-delivery-service/src/services/push-payload.ts),
>    [chat-delivery](../../services/chat-delivery.md#transport--single-gateway-fcm))
> 2. **A conversation at `none` sends every frame silent, a call invite included (2026-10-14).**
>    At `none` it arrives silent and will NOT ring; at `mentions` it still rings, because both
>    native handlers branch on `call_invite` BEFORE the level gate. **DECIDED 2026-10-18: a ring
>    obeys the conversation's own CALL PERMISSION, not the level** - see
>    [the call permission](#the-call-permission---its-own-setting-per-conversation-decided-2026-10-18).
>    ([chat-delivery](../../services/chat-delivery.md#a-conversations-notification-level---the-server-applies-none-the-device-decides-mentions))
> 3. **The network blocker was removed by DESIGN, not by an outbound rule (measured 2026-10-15).**
>    The School border drops the host's outbound UDP, and the SFU's TURN client (webrtc-rs 0.17)
>    speaks only UDP 3478 to Cloudflare TURN, so the SFU path can never connect from production
>    ([sections 1 and 8, row 1c](../../infrastructure/realtime-media-feasibility.md)). 1:1 calls
>    are peer to peer between the CLIENTS, the phones reach Cloudflare TURN from their own
>    networks, and the host only carries signalling on 443
>    ([Lot 1](#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only)). No outbound rule was
>    ever granted; the minimal ask (ONE outbound rule) stays unmet and only a future SFU call
>    (group calls) would need it.

## Turning calls on in production - audio 1:1 only (owner, 2026-10-21)

**The decision.** The first public build with calls enabled in production is **AUDIO 1:1 ONLY**,
with the call kept alive in the background on Android and on the iPhone; video follows later.
The flip PR (2026-10-22) compiled in-app audio calls in (an invite, the per-conversation permission control and the sibling-status request also honour `calls_mode` client-side through `callsAvailable(serverCallsMode())`) (`CALLS_COMPILED = true`); what keeps production shut is the server's `calls_mode` (`off` at deploy), and the flip is merged and shipped only when every blocker below is lifted. This section is
the only copy of the blocker list and of the order; [revival plan](calls-revival-plan.md) keeps the
2026-10-15 design and the test matrix (section 7), the [backlog](../../backlog.d/p1-blocks-production-calls-mode-what-is-owed-before-production-calls-r.md)
row points here. Investigated 2026-10-21 against `main` at `1.3.1-alpha.5`.

**The owner's answers, 2026-10-21** - not to be re-opened:

| # | Question | Answer |
| --- | --- | --- |
| Q1 | Does the first release ring an app that is closed or in the background (CallKit / PushKit on the iPhone, the full-screen `call_ring` on Android)? | **No.** The native ring comes later. A call rings an app that is OPEN; it is then KEPT in the background (B8, B9) |
| Q2 | A server-side kill switch (WP-C13, one data migration on `platform_config`) before the flip? | **Yes** - a hard pre-flip blocker (B12) |
| Q3 | `minClientVersion` raised to the first calls stable once both stores serve it? | **Yes** |
| Q4 | The iPhone `audio` mode is app-wide: may reels and voice messages keep playing with the screen locked? | **Accepted** |
| Q5 | The privacy-policy and register wording of #2013 | **Settled 2026-10-24: merged (#2183), no human review owed** |
| Q6 | An audio rate for `CALL_RELAY_KBPS_PER_DEVICE` on production as a stopgap? | **No.** B7 is fixed first; the production budget variable is left as it is |

### The blockers, each with its evidence

`built` = merged on `main` or in the PR named; `draft` = an open draft PR; `read` = observed on
hardware; `owed` = not done. A blocker closes only when its last column is true.

| # | Blocker | State (2026-10-21) | Closed by |
| --- | --- | --- | --- |
| B0 | **No video in production.** `CALLS_VIDEO_ENABLED` was `CALLS_ENABLED`, so the flip would have shipped it; and the flag only hid the buttons - an invite with `hasVideo: true` (a modified client, or a later build) made `acceptCall` open the camera with no control on screen to close it | **built in #2171**: `CALLS_VIDEO_ENABLED = deployEnvironment() === 'development'` (`features.test.ts`), and `CallService` holds it at every boundary - the invite rings as audio (`incomingHasVideo`), `startCall` and `acceptCall` never ask for video, `cameraOn` (every camera open) refuses, and a peer's video m-line is answered `recvonly`, decrypted (so the E2E path check still judges it) and never shown. `inactive` would be possible (either side may renegotiate after the first remote description) and would spare the peer's video bandwidth and CPU; it is not taken because the path check's treatment of a negotiated m-line carrying nothing is unmeasured on a phone, and until video ships only a modified client sends one - when video ships, the floor rises past the audio-only stable or `inactive` is built. Pinned by `CallService.p2p.test.ts` ("an audio-only build", and "judges the peer's HIDDEN video": frames -> conclusive, packets with no frame -> ended) | code done; **owed on a phone**: that a receiver transform whose track has NO SINK is still fed frames (unproven on WebKit) - CALL-L1 row 13, no false `CallE2eBypassedError` on the iPhone and the Mi 9T |
| B1 | The scope of the native ring | **decided** (Q1): not in the first release | B2' |
| B2 | The native ring: WP-C5 (Android: names from the phone's local copy, out of the `call_ring` payload; `canUseFullScreenIntent`; decision 7 natively) and WP-C6 (iOS: no PushKit token was ever registered; every VoIP push must report a CallKit call; the answer with MLS behind the PIN). **Also to gate in the SAME commit as the native-ring switches**: both rings still ANNOUNCE a video call for a `hasVideo` invite (Android `CanariFirebaseMessagingService.kt` `setIsVideo` / `notif_incoming_video_call`, iOS `canari_push.mm` CallKit `update.hasVideo`) - on an audio-only build they must announce audio | **later - not the first release**; **Latent for this work package:** once `kCanariCallsEnabled` flips, tapping the generic FCM alert while the app is not in the foreground goes through `CanariHandleFcmData` (`canari_push.mm`, the `call_ring` branch) and raises a CallKit ring with EMPTY names - gate that branch then; the iPhone half (WP-C6) is designed and partly built behind the switch, [below](#the-native-ring-on-the-iphone---pushkit-and-callkit-wp-c6-owner-2026-10-22) | its own chantier, with video or after |
| B2' | **Two facts instead of one**: `CALLS_COMPILED` for in-app calls and background continuation (`audio`, the microphone foreground service, the microphone purpose strings), a second constant for the native ring (`voip`, `kCanariCallsEnabled`, Kotlin `CALLS_ENABLED`, `USE_FULL_SCREEN_INTENT`), each set asserted by `callsCompiled.test.ts`. **And the iOS FCM ALERT**: no iPhone has a `voipToken`, so `CallsService.ringViaFcm` would send EVERY iPhone callee a visible alert titled with the caller's name in clear (against decision 6), opening an app that may not answer in time - removed, or decided. That branch IS reachable in the first release (unlike the native ring), and its body says "Appel entrant" whatever `hasVideo` is - if kept, it must never announce video | **built in the flip PR (2026-10-22)**: the two facts exist (`CALLS_NATIVE_RING_COMPILED`); the iPhone FCM alert is GENERIC - title "Canari", body "Appel entrant" / "Incoming call" from `push_token.locale` (`incomingCallAlertBody`), and the caller and conversation names are removed from the iOS data and APNs keys too (FCM merges `data` into the payload); pinned in `calls.service.spec.ts`. The iPhone's notification extension has a `call_ring` case that KEEPS the server's wording and only files it (thread, deep link without `acceptCall`, `canariCallId`, time-sensitive) - without it the type fell to the MLS ladder and the alert was overwritten; the APNs request carries `apns-expiration` (+60 s, which only bounds APNs STORE-AND-FORWARD for a phone that was off - a delivered banner stays until removed) and `apns-collapse-id` (the callId); `call_ring_end` removes the delivered banner by `canariCallId` (best effort) and so does app activation (the banner's `deepLink` is a chat link, cleared with the message banners). Android keeps its names | a draft |
| B3 | **The review of #1997, crypto half**: one key per direction + AAD on every frame, the key-mismatch toast (F5) | **built (#2176)**: #2013 ported onto `main` (per-direction keys, AAD on every frame, the mismatch notice), adversarially reviewed | CALL-L1 rows 1-4 re-read on it |
| B4 | **The `fp=` log line printed 4 bytes of the call key** | **built (#2176)**: a SHA-256 fingerprint per direction (`send_fp`/`recv_fp`, `utils/callKeys.ts`), first in #2171 | done |
| B5 | **F4 - say who sees what**: each party learns the other's IP, only after the callee answers; Cloudflare sees every ANSWERED call (IPs, time) and its TURN relays some (IPs, time, volume, never audio). Into `compliance/register-of-processing.md` and `/legal/privacy`, together | register rows C21 + TURN processor in #2176; the `/legal/privacy` paragraphs merged in #2183 | **DONE: no human review of the wording is owed (owner, 2026-10-24)**; it is published with the next stable |
| B6 | **A call report** (`[CALL_REPORT]`, WP-C2): without it a failing production call is found by hand, and B7 cannot tell relayed from direct | **built (#2176)**: #2011 ported onto `main` | one reading from a phone's exported log |
| B7 | **The TURN budget counts every call as relayed at 3000 kbps per device** (`accumulateTurnUsage`): 950 GB is ~700 device-hours, ~350 call-hours a month, after which `ice-servers` answers 503 to EVERY call. Only `relayed=yes` costs in P2P, and CALL-PATH-LINE (P3) showed `relayed=` can be wrong | **being built** (another agent); the production variable stays alone (Q6) | relayed calls only, at what they cost |
| B8 | **Background, Android (WP-C-BG-A)** | **built** (#2162, in `1.3.1-alpha.5`); the declaration is in `src/main/AndroidManifest.xml` since the flip PR (2026-10-22); Play FGS declaration FILLED by the owner 2026-10-21; **twelve readings owed** on the Mi 9T ([below](#wp-c-bg-a---the-android-ongoing-call-service-2026-10-20)) | the readings |
| B9 | **Background, iPhone (WP-C-BG-I)**: the `audio` mode, in the committed plist since the flip PR (2026-10-22) | **built** (#2164, in `1.3.1-alpha.5`); the failure was read before the fix; **after-fix reading owed** (CALL-L1 row 12); the app-wide side effect ACCEPTED (Q4) | row 12 `PASS` |
| B10 | **The hardware readings of the audio path**: CALL-L1 rows 0-12 on the current build; the Tier B audio cells (K1, K9, K12 on Mi 9T / iPhone / desktop; K6 both phones) of [the matrix](calls-revival-plan.md#7-the-test-matrix) | **partly read**: audio clean both ways and both transforms fed on `1.3.1-alpha.4` (#2161); forced TURN relay over UDP, TCP and TLS 443 clean on all three engines (#2165, readings PR open on 2026-10-21); row 8 `PASS` on alpha.2. **Owed**: row 0, rows 9-12 on the build carrying their fixes, cellular and campus Wi-Fi (no SIM on the bench), CALL-WS-V6's fix (#2167) on an IPv6-broken Wi-Fi | the board rows `PASS`, never `PASS-DIRTY` |
| B11 | **Two P2 defects met on the bench**: CALL-PAIR-STALL and CALL-LATE-RING ([backlog](../../backlog.md#p2---a-call-that-never-paired-and-a-ring-for-a-call-already-hung-up-2026-10-20)) | **owed**: the dev `call-service` log of that minute and the iPhone's exported log, before any cause is named | diagnosis, then a fix or a refutation |
| B12 | **A kill that is not two store releases** (WP-C13, `platform_config.calls_mode` = `off/testers/on`, enforced at `initiate`/`ring`/`room-token`) | **decided yes (Q2), a HARD PRE-FLIP BLOCKER; being built** (another agent) | merged and its `off` read refusing a ring, before the first alpha with the flip |
| B13 | **The production server preflight** (read-only, below) | **checklist written** (P1-P10, each with its command, 2026-10-21); **owed**: running it after #2180 deploys production, P7 and P8 (c) in the review window | every line of the preflight read |
| B15 | **An unanswered call was written as a call with a duration** (CALL-WEB-4..7, `1.4.1-alpha.6`, 2026-10-26): cancelled, declined, unreachable and busy calls all read "lasted less than a minute". Two writers disagreed about the same call (`recordCallMissed` and `recordCallEnded`) | **built (draft PR, 2026-10-27)**: ONE writer, `recordCallEnded(ctx, groupId, callId, outcome?, starterId?)` in `utils/chat/callSystemMessages.ts`; `recordCallMissed` is deleted. The outcome is TYPED (`CallEndReason`: `cancelled` / `declined` / `not-answered` / `busy`, absent = answered), sent on the hangup as proto `CallMsg.end_reason`, stored in the row as `callEvent.outcome`, never read from text. See [the call record](#the-call-record-one-writer-a-typed-reason-2026-10-27) | read on the web rows (CALL-WEB-4..7), then the blocker closes |
| B16 | **A busy callee left the second caller ringing for 60 s** (CALL-WEB-7) | **built (draft PR, 2026-10-27)**: a busy device answers the invite with a typed `CallMsg.busy` frame (never a hangup); the caller's device ends its ring at once, toasts `call_busy`, sends a hangup carrying reason `busy` (stops the callee's other devices and the server ring) and writes `busy`. See [the call record](#the-call-record-one-writer-a-typed-reason-2026-10-27) | read on CALL-WEB-7 |
| B14 | **The store answers** (below): Apple review notes + demo accounts + video, privacy labels; Play Data safety | **drafted** (the microphone string, the review notes, the privacy candidates, 2026-10-21); **owed**: the owner's answers to the privacy table, the demo pair, the video (Play FGS declaration: DONE 2026-10-21) | WP-C9 |

### The call record: one writer, a typed reason (2026-10-27)

B15 and B16, built together because the busy answer is one of the reasons.

- **The writer is `recordCallEnded`**, and nothing else writes a call's final row. It is idempotent
  per callId and final (`callEvent.endedAt`, never the text, guards a duplicate). `recordCallStarted`
  only makes the ringing row, and gives way to an end that won the race.
- **The reason is a type, sent by the side that knows.** Hangup carries `end_reason`: `cancelled`
  (the caller hung up a ring), `declined` (the callee refused it), `not-answered` (the ring window
  closed; also a call lost after its invite), `busy`. No reason = an answered call (duration) or a
  hangup of a build from before the field.
- **Two call sites, disjoint by origin.** A fact that arrives from ANOTHER party (an MLS hangup, an
  invite) is written by `handleCallSignalForChat`; a fact this device caused (it hung up, declined,
  its ring timer closed, a busy answer arrived) is written through `CallChatNotifier.onCallEnded`.
  `endCall(notify, reason, remoteOrigin)` skips the notifier when the MLS hangup is the other party's.
- **Answered means the callee reached the room.** A caller in `calling` whose `peerArrived` is set
  (`PeerReady`) has an ANSWERED call, even if its media never connected: no unanswered reason, a
  duration. So the relay's `PeerLeft` (a local end) and the callee's MLS hangup (remote) reach the
  one writer with the same fact, in either order. A failure after the invite left (`failCall`, a
  refused resume, a failed setup) is `not-answered` when nobody arrived, and ALWAYS sends the
  hangup now, so the other party's row is finalized.
- **Reading by side.** The caller reads its own sentence (`chat_system_call_cancelled`,
  `_not_answered`, `_declined`, `_busy`); the callee reads "missed call" for cancelled, not answered
  and busy, and "declined" for a ring it refused. A device with no started row for a call (it never
  rang: busy, offline during the ring) gets its missed call from the hangup, created when the
  sender is another account and the reason is not `declined`. A call that failed before its invite
  left (initiate refused, no ICE servers, no microphone) has no outcome, so no row is written for
  it. Rows are written with `soleWriter` so a bulk ingest never buffers them away from their end.
- **BUSY end to end.** Busy means "this device is in a call". It is answered ONLY for an admitted
  invite (permission, ring window, no block), after those checks, with `mkCallBusy` (proto
  `CallMsg.busy = 11`, ephemeral like every call frame). Never from the ended summary, never for the
  invite of the call it is already in. GLARE (both sides calling each other in one conversation):
  the LOWER callId wins and sends no busy; the higher one drops its own call (`cancelled`) and
  rings the winner. The caller acts on a busy answer only for its own callId, while `calling`, with
  nobody arrived, from another account. The native classifier lists the payload as control that ends
  nothing (`proto_fields.rs`, pinned).
- **An invite during the 1.5 s ended summary RINGS**: the summary and its timer are cleared first
  (the timer is a field, cleared by `cleanup`, so it cannot cut a later call's summary short). A
  `calling` call with no id yet (`startCall` sets the state before the server gives the id) has rung
  nobody and loses any glare in its conversation.
- **Glare noise, accepted**: the loser's `cancelled` hangup reaches the winner, whose writer files a
  missed call from the loser. **Compat, dev only**: a client built before `busy` reads a busy frame
  as an invite and logs a false "carries no ring window" WARN; calls are dev builds only, so no
  user sees it.
- **Not decided, recorded**: a callee with a second, idle device stops that device's ring too.
  The ended-summary overlay of a busy caller shows the generic ended screen (the toast and the
  record carry the message). The row text is baked per side at write time; rendering from
  `callEvent.outcome` / `starterId` instead is a P3 in the [backlog](../../backlog.md).
- Tests: `callSystemMessages.outcome.test.ts` (writer, sides, races, signal path),
  `codec.call.test.ts`, and the busy / reason describes of `CallService.p2p.test.ts`.

### The order

1. ~~The owner's answers~~ - taken 2026-10-21 (above), except the wording of Q5, which comes later.
2. **Code, every piece dev-only, none flips anything** - each its own draft PR: B3 + B5 (the port of
   #2013), B6 (the port of #2011), B7, B12, B2'. B0 and B4 are #2171.
3. **Pre-releases and readings**: each piece reaches the bench through an ordinary `vX.Y.Z-alpha.N`
   (dev + testers); B8, B9, B10, B11 are read there. **The App Review video and the Play video are
   recorded FROM these runs**, never staged afterwards (revival plan section 8).
4. **The production preflight** (B13), read-only, from a signed-in production session and the host.
5. **THE FLIP, ONE COMMIT, ONE PR** - BUILT (owner, 2026-10-22: calls reach production fast), as a draft pull request off `main`; the table below is what it moved. It merges only when the blockers above say so, and the server's `calls_mode` stays `off` at deploy. (Draft #2039 is the 2026-10-18 rehearsal of a flip WITH the
   ring: rebuild it on `main` after B2', do not rebase it). With Q1 = no, it moves:

   | Moves | File | Asserted by |
   | --- | --- | --- |
   | `CALLS_COMPILED = true` | `frontend/src/lib/features.ts` | `features.test.ts` |
   | `audio` in `UIBackgroundModes` | `canari_iOS/Info.plist` | `callsCompiled.test.ts` |
   | the microphone purpose string names calls | `Info.plist`, `fr.lproj` and `en.lproj` `InfoPlist.strings` | `callsCompiled.test.ts` |
   | the microphone foreground service moves from `src/calls/` into `src/main/AndroidManifest.xml`, and `build.gradle.kts` stops merging it on `VITE_DEPLOY_ENVIRONMENT` | Android | `androidCallServiceManifest.test.ts`, `android.yml`'s built-manifest step |
   | `ios.yml`'s pre-release `audio` patch is deleted with its two cases in `callsCompiled.test.ts` (dead code once the committed plist carries `audio`) | `.github/workflows/ios.yml` | `callsCompiled.test.ts` |
   | **does NOT move**: the native ring's four (`voip`, `kCanariCallsEnabled`, Kotlin `CALLS_ENABLED`, `USE_FULL_SCREEN_INTENT`) under their own constant (B2'), and `CALLS_VIDEO_ENABLED` | | `callsCompiled.test.ts`, `features.test.ts` |

6. **`vX.Y.Z-alpha.1` with the flip** -> dev and the store testers, `calls_mode` at `testers` (as
   #2180 builds it there is no `testers` value: pre-releases talk to dev, whose own row is open). Tier B
   audio cells re-read on it, the review build's notes and video checked. **Beta App Review**: an
   external TestFlight group reviews the declared modes; keep the flip to internal testers or have
   the notes ready ([mobile](../mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on)).
7. **The stable** `vX.Y.Z` (it ships the alpha above) -> production web, Play, the App Store; then
   `calls_mode` `on` (`audio` as #2180 builds it; a production change, so the owner's action at
   `/admin/platform`). **Opened as soon as production deploys, NOT after
   the stores publish**: the App Review build talks to PRODUCTION, so a reviewer who meets `off`
   finds a declared `audio` mode whose feature refuses - the 2.5.4 refusal of 2026-08-31 again
   ([B14](#the-store-answers-b14)). Production web deploys only once both store jobs are green, so
   by then the submission is in; before that moment no production client has calls compiled, which
   is why the mode may open then without exposing anything.
8. **After both stores serve it**: `minClientVersion` raised to it (Q3); the first week's `[ring]`,
   `session end` and TURN usage read on production.

### The production server preflight (B13) - what must be checked, read-only

Production HAS Cloudflare TURN and has never used it: the `canari-calls` key carried 0 bytes in the
30 days to 2026-10-16 ([revival plan](calls-revival-plan.md#14-probes-of-2026-10-16-clients), Q4).

- **The secrets reach the container**: the production deploy log of `chat-delivery-service` raises no
  "not set" warning for `CLOUDFLARE_CALLS_API_TOKEN` / `CLOUDFLARE_TURN_KEY_ID`
  (`env-manifest.tsv`: `warn`), and `CALL_ROOM_SECRET` is set (`required`).
- **The key answers**: from a signed-in production session, `GET /api/calls/ice-servers` answers 200
  with `turn:` URLs over udp, tcp and `turns:` 443 (the endpoint is not behind the client switch), and
  the key id it uses is the `canari-calls` key of the Cloudflare account.
- **The budget**: B7's meter in the deployed image and readable with the production token (P6
  below; the Redis estimate it replaces goes with #2180); the production budget variables are not
  touched (Q6).
- **The kill switch**: `calls_mode` reads `off` on production before the stable deploys (B12).
- **The relay**: `call-service` runs on production with the p2p mode (the image of the release), and
  `wss://canari.emse.fr/api/call` upgrades through the host nginx. **The production path differs
  from dev's**, so CALL-L1 row 0 (an idle call's keepalive Pong across the public path, no
  `held dead`) read on dev does not answer for production: it is read once on the production path,
  from a local build carrying the flip pointed at production, or as the first reading after the
  stable deploys and before `calls_mode` goes `on`.
- **Push**: Firebase is initialised on production (the `call_ring_end` and missed-call paths). The
  APNs VoIP key is NOT needed for the first release (Q1).
- **No UDP from the host is needed**: 1:1 is peer to peer, the host carries signalling only
  ([realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md#8-what-works-with-no-port-opened-by-the-dsi-measured-2026-10-16)).
  Nothing is asked of the DSI.

#### The checklist, with the command that reads each line (2026-10-21)

Every line below READS; none writes production. It is run once, after the release carrying B7 and
B12 (#2180, open on 2026-10-21) has deployed production and before the flip's stable is tagged; its
outcome is a row of the [readings](../../device-readings-2026-10.md) pages, each line `PASS` or the
defect it found. **The host's address, its SSH alias, the database and Redis credentials and the
Cloudflare account and token values are in the private operations notes**, never here: the commands
use `<prod-host>` and read every secret from the environment of the machine that runs them, never
from an argument. Host commands are Docker reads, free under the shared-host rule (CLAUDE.md).

**One thing #2180 changes for this list: with `calls_mode = off` (production's default),
`ice-servers` refuses (403 `CALLS_DISABLED`) and the `[TURN-METER]` report is silent.** So the two
Cloudflare lines (P5, P6) are read straight from Cloudflare while the switch is closed, and the
end-to-end `ice-servers` line (P7) is read in the review window, once the mode is opened (the order,
step 7).

| # | What must be true | How it is read (read-only) | `PASS` when |
| --- | --- | --- | --- |
| P1 | Migration 014 (core-service, `014_platform_config_calls_mode.sql`, #2180) is applied and the switch reads `off` | `PROD_PG=$(docker ps --filter label=com.docker.compose.project=canari-prod --filter label=com.docker.compose.service=postgres --format '{{.Names}}')`, then `docker exec "$PROD_PG" sh -c 'psql -At -U "$POSTGRES_USER" -d auth_db -c "SELECT filename, applied_at FROM schema_migrations WHERE filename LIKE '"'"'%014_platform_config_calls_mode.sql'"'"'; SELECT calls_mode, min_client_version FROM platform_config WHERE id = 1; SELECT conname FROM pg_constraint WHERE conname = '"'"'CHK_platform_config_calls_mode'"'"';"'` | one ledger row; `off`; the constraint present. A missing row 1 is a defect, not an `off` (`utils/calls-mode.ts` logs it at error) |
| P2 | The switch as clients see it, and the version floor | `curl -s https://canari.emse.fr/api/version` (public, no session) | `calls.mode` is `off`; `version` is the deployed stable; `minClientVersion` is the floor of today - raised only AFTER both stores serve the calls stable (Q3, step 8), so a raise before that is a finding |
| P3 | Every calls secret reached the containers | the production deploy job of that release: `gh run view <run-id> --log \| grep 'is not set'` (`render-env.sh` prints `::warning::<KEY> is not set - <note>` for a `warn` key, `env-manifest.tsv`) | no line for `CLOUDFLARE_CALLS_API_TOKEN`, `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_TURN_ANALYTICS_TOKEN`, `FIREBASE_SERVICE_ACCOUNT_JSON`. `CALL_ROOM_SECRET` and `JWT_SECRET` are `required`: a deploy without them fails, so a green deploy proves them. Names only, never `docker exec ... env` with values printed |
| P4 | `call-service` runs the release's image and is healthy | `docker ps --filter label=com.docker.compose.project=canari-prod --filter label=com.docker.compose.service=call-service --format '{{.Image}} {{.Status}}'` (the compose healthcheck is `curl -f localhost:3004/api/health`, not reachable from outside) | the image tag is the deployed stable; `Up ... (healthy)`; `docker logs --since 24h <that container> 2>&1 \| grep -c ERROR` explained line by line, never skipped |
| P5 | The TURN key mints credentials (Cloudflare Realtime) | from the workstation, `POST https://rtc.live.cloudflare.com/v1/turn/keys/$CLOUDFLARE_TURN_KEY_ID/credentials/generate-ice-servers` with `Authorization: Bearer $CLOUDFLARE_CALLS_API_TOKEN` and `{"ttl": 60}` - the call `calls.service.ts` makes. **The one line that is not a pure read**: it mints a 60 s credential nobody uses, which relays nothing and costs nothing | 201 with `turn:` URLs over UDP 3478, TCP and `turns:` 443; the key id is the `canari-calls` key named in the private notes |
| P6 | The meter B7 trips on is readable with the production token | from the workstation, the GraphQL `settings` query and one day of `callsTurnUsageAdaptiveGroups` (`sum { egressBytes }`) under `viewer.accounts(filter: { accountTag: $CLOUDFLARE_ACCOUNT_ID })`, at `https://api.cloudflare.com/client/v4/graphql` with `$CLOUDFLARE_TURN_ANALYTICS_TOKEN` - the queries are the ones #2180's `turn-usage-meter.service.ts` builds (B7) | `enabled: true`; the per-date query answers with no `errors` (the one query #2180 measured only on dev); the month's egress is the known baseline (0 bytes to 2026-10-16) or explained. **This also closes the "per-date query unexercised" line of B7 on production** |
| P7 | `ice-servers` answers end to end, through the switch and the meter | in the review window (mode `audio`), from a signed-in production session: `GET /api/calls/ice-servers` in the browser's DevTools (the access token stays in memory, so not `curl`) | 200 with the `turn:` URLs of P5 and no `turn.status: 'unavailable'`; the hour's `[TURN-METER]` line in the `chat-delivery-service` log reads `x/y GB` at `log` level |
| P8 | The routes: `/api/calls/` reaches chat-delivery, `/api/call` upgrades to call-service | (a) `curl -si https://canari.emse.fr/api/calls/ice-servers` with no session; (b) `curl -si -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' https://canari.emse.fr/api/call` with no session; (c) in the review window, the `101 Switching Protocols` of `wss://canari.emse.fr/api/call` in a signed-in session's DevTools | (a) and (b) answer the `auth_request` refusal (401), never the SPA's `index.html` or a 404 - which proves the host nginx, the edge and the container nginx all route the prefix (`Dockerfile.frontend`, `location /api/calls/` and `location /api/call`); (c) a `101`, and the socket held across an idle minute (CALL-L1 row 0 on the production path, above) |
| P9 | No call state is left over from before | `docker exec <prod redis> redis-cli --scan --pattern 'call:*' \| wc -l` and `--pattern 'turn:*'` (the Redis container name as P1 finds Postgres') | `call:*` 0 with calls off (a non-zero count is a room created while the switch was open - who opened it?); `turn:metered:*` only #2180's keys, and no `turn:usage:<this month>` (the removed estimator's key, written by no deployed code once #2180 ships) |
| P10 | Push for the call paths | the `chat-delivery-service` boot lines: `docker logs <container> 2>&1 \| grep -i firebase \| head` | Firebase initialised (it serves `call_ring` and `call_ring_end`); the APNs VoIP key is NOT checked - the first release has no native ring (Q1) |

**What this list does not read, and where it is**: the privacy wording (B5), the store forms (B14,
below), and every hardware reading (B8-B10) - each is its own blocker.

### minClientVersion

- **No wire compatibility is owed to an older production client**: every stable so far has
  `CALLS_ENABLED = false`, so none ever placed or answered a call. The wire changes of B3 matter
  between dev builds only.
- **The first calls stable must ignore `hasVideo`** (B0): a later build with video will send video
  invites to it, and it answers them as audio. That later build is 1.5.2, and what an audio-only
  stable does against it is [below](#a-15x-audio-only-client-against-a-152-client-with-video).
- **A callee on an older stable cannot answer, and sees this**: the in-app invite is dropped and
  logged (`calls disabled - ignoring signal`); an older Android logs `calls disabled` and rings
  nothing; an older iPhone gets the FCM ALERT of B2' - generic since the flip, but a build before the flip has NO `call_ring` case in its notification extension, so there the alert goes down the MESSAGE ladder (the encrypted-message fallback and message buttons replace "Appel entrant") until `minClientVersion` rises past it. The caller sees the call
  go unanswered, then the missed-call line. The push token row carries no app version, so the server
  cannot ring "only the devices that can answer".
- **Decided (Q3)**: `minClientVersion` is raised to the first calls stable once BOTH stores serve it.

### The store answers (B14)

**Apple, for the stable** (the pre-release half is on [mobile](../mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on)):

- **Superseded 2026-10-31:** the committed `Info.plist` now carries `voip` AND `audio` (`CALLS_NATIVE_RING_COMPILED = true` since 2026-10-30), so the review notes below must show the CallKit ring. The earlier line read: `audio`, NOT `voip` (Q1); the pre-release patch is gone (the flip PR deleted it from `ios.yml`).
  `audio` is the mode Apple names for a call's audio in the background; 2.5.4 asks that the reviewer
  can SEE it used - the refusal of 2026-08-31 was a `voip` mode it could not locate.
- `NSMicrophoneUsageDescription` names calls (base, `fr`, `en`), asserted by `callsCompiled.test.ts`.
  `NSCameraUsageDescription` did not change for the audio stable; it names video calls since 1.5.2
  ([turning video on](#turning-video-on-in-production---11-video-in-152-owner-2026-10-30)).
- **Review notes and demo accounts**: two PRODUCTION accounts sharing a direct conversation, call
  permission allowed, no block. A reviewer has one device: a team member answers the second account
  in a stated window, and the notes say how to reach the call screen. They say what `audio` is for:
  "an ongoing call keeps its microphone when the screen locks".
- **The video**: recorded on the iPhone during the Tier B runs - a call placed from a DM, the
  microphone prompt naming calls, both parties heard, the screen locked mid-call and the voice still
  carried, hang-up.
- **Privacy nutrition labels** (App Store Connect, not in this repository): the call audio is E2E
  and never stored or readable by the server - whether that is "not collected" under Apple's
  definition is **(unverified)**; the call METADATA (who called whom, when, how long - server logs)
  and the IP seen by the peer and by Cloudflare are new. Read the current labels first, then decide.

**Google Play**:

- **Foreground service declaration** (`FOREGROUND_SERVICE_MICROPHONE`): FILLED by the owner
  2026-10-21.
- **`USE_FULL_SCREEN_INTENT`**: not declared in the first release (Q1).
- **Data safety form**: the same facts as Apple's labels - audio E2E, never stored; call metadata;
  IPs to the peer and to Cloudflare as a relay. Whether E2E audio must be declared as collected under
  Play's definition is **(unverified)**; update the form in the same week as the stable.

#### The drafts still owed (2026-10-21)

Everything above says WHAT each store needs; these are the texts and the gaps, read against the
repository on 2026-10-21. **Convention, as on [store-ugc-answers](../../store-ugc-answers.md): a
store's definition restated here is _(unverified against today's text)_** - re-read the form itself
before filling it. The forms are the owner's one-off clicks (App Store Connect, Play Console).

**1. The microphone purpose string - the plist names calls since the flip PR (2026-10-22), as
`callsCompiled.test.ts` requires once `CALLS_COMPILED` is true.** The base `Info.plist` and both
`InfoPlist.strings` hold the text below (written before the flip as the proposal), and the test's
whole-word match (`appels?` / `calls?`) is what holds it:

| Where | Proposed text |
| --- | --- |
| `Info.plist` (base, French) and `fr.lproj` | `Canari utilise le microphone pour vos appels audio, pour enregistrer des messages vocaux et le son des vidéos que vous filmez pour vos publications et vos CanaReels.` |
| `en.lproj` | `Canari uses the microphone for your audio calls, to record voice messages and the sound of the videos you film for your posts and CanaReels.` |

(Since 1.5.2 both read "audio and video calls" / "appels audio et vidéo", and the camera string names
video calls too: [turning video on](#turning-video-on-in-production---11-video-in-152-owner-2026-10-30).)

No other key moved for the audio stable: `NSCameraUsageDescription` kept its text (no video), and the app declares no
`NSLocalNetworkUsageDescription` in a store build (the local-bench patch of `ios.yml` is
pre-release only). Android has no purpose string for `RECORD_AUDIO`; its runtime prompt is the
system's own. **A gap on the PRE-release side**: a pre-release build calls (and, on dev, offers
video) with the stable's microphone string, so an EXTERNAL TestFlight group would put a calling
build before Beta App Review with a purpose string that never mentions calls - one more reason the
flip's alpha stays with internal testers ([mobile](../mobile.md#where-the-submission-stands-and-what-each-half-is-waiting-on)).

**2. The review notes, draft (English; App Store Connect > App Review Information > Notes).** The
bracketed parts are filled at submission; credentials go in the Sign-In Information fields, never in
this repository.

> Canari is the messaging app of the Mines Saint-Etienne student community. This version offers
> one-to-one AUDIO and VIDEO calls between two members who share a direct conversation. Calls are
> end-to-end encrypted: the sound and the picture go directly between the two devices, relayed
> through Cloudflare's TURN service only when no direct path exists, and our servers never receive
> them. Nothing is recorded.
>
> To test: (1) on the sign-in screen, choose "Connexion externe (service-account)" and sign in with
> the account given in Sign-In Information; (2) open the direct conversation with [second account];
> (3) tap the call button in the conversation header [confirm the control's label on the review
> build] - iOS asks for the microphone, and the request names calls; (4) a member of our team answers
> on a second device [window, Europe/Paris, and a contact to arrange another time]; (5) during the
> call, lock the screen: the call continues. That is what the `audio` background mode is used for -
> an ongoing call keeps its microphone while the screen is locked.
>
> For a VIDEO call, tap the video-call button in the conversation header [confirm the control's
> label on the review build]: iOS asks for the camera, and
> the request names video calls. The camera runs only during the call; the member can turn it off
> or switch between the front and back cameras from the call screen, and it is turned off while the
> app is in the background (the audio continues) and back on when the app returns.
>
> SUPERSEDED 2026-10-31, DO NOT SUBMIT AS WRITTEN: the two sentences that used to stand here ("declares no
> `voip` background mode, uses neither CallKit nor PushKit, a call rings only while the app is open")
> are FALSE since the owner's decision of 2026-10-30. The committed `Info.plist` declares `voip`
> and `canari_push.mm` registers PushKit and reports every VoIP push to CallKit
> (`CanariReportVoipCall`). Rewrite them to show the reviewer where `voip` is used (a call to a
> locked iPhone rings on the CallKit screen; see
> [the native ring](#the-native-ring-on-the-iphone---pushkit-and-callkit-wp-c6-owner-2026-10-22)),
> because 2.5.4 refused a `voip` mode it could not locate. From the conversation, a member can
> report and block the other; a blocked member cannot call.

**When these notes apply (1.5.2).** The review build talks to PRODUCTION, so the video paragraph is
true only while `calls_mode` is `audio_video`. If production is still at `audio` when 1.5.2 is
submitted, the video paragraph is replaced by "Video calls are built in this version and are being
opened in stages: the camera string names them, and the video-call button appears once the server
enables them" - never left claiming a button the reviewer cannot find (2.5.4 refused a declared
feature it could not locate on 2026-08-31).

**3. The demo pair - owed, and one fact is not known.** The reviewers' way in is the existing
"Connexion externe (service-account)" sign-in ([ecosystem-convergence](../../ecosystem-convergence.md),
item 12) with the store-review service account, which feeds exclude by design
([moderation-and-blocking](../../moderation-and-blocking.md)). A call needs a SECOND production
account, a direct conversation between the two, the call permission allowed on both sides and no
block - the owner's one-off. **Unverified: whether a service account can be rung at all.** Nothing
read here excludes one from `initiate` or `ring` (the exclusion found is a FEED filter), but it has
never been tried; it is read by one call between the two accounts on production in the review window
(preflight P7, P8), before the submission is sent.

**4. The privacy deltas, as candidates for the owner** - the facts are register row C21 and the
Cloudflare processor row ([register](../../compliance/register-of-processing.md)), the only copy;
this table maps them onto the two forms. **Read the CURRENT label and Data safety answers first** -
neither form is in this repository - and decide together with B5's wording, so the forms and
`/legal/privacy` say the same thing.

| Fact (C21) | App Store privacy label (candidate) | Play Data safety (candidate) |
| --- | --- | --- |
| Call audio, end-to-end encrypted, never stored or readable by the server | not collected, if Apple's "collect" (data you or a partner can access beyond servicing the request in real time) reads E2E media as outside it | not collected, if Play's exemption for end-to-end encrypted data still reads as it is remembered |
| Call metadata in clear on the server (room binding, presence, ring fan-out; logs per C13) | Usage Data > Product Interaction, linked to the user, App Functionality - only if the current label does not already cover messaging metadata | App activity > Other actions, collected, App functionality - same proviso |
| The peer and Cloudflare see each device's public IP, on every ANSWERED call (an unanswered call sends it to neither) | Apple counts an IP as an identifier only for tracking or as derived location; neither applies, so probably no new row | no new data type if no location is derived from it; Cloudflare is a service provider (the form's sharing exemption) |
| The `[CALL_REPORT]` lines in the in-app log | not collected: the log leaves the device only when the member exports it | same |
| The ring push carries caller and conversation names (C7, C21) | already covered by the messaging rows, if they name push content | same |

**What remains after these drafts**: the owner's answers to the table, the demo pair, the video
(recorded during the Tier B runs, never staged), and the listing texts
([store-listings](../../store-listings.md#2-the-current-play-texts-and-what-is-stale-2026-10-09)).

## Turning video on in production - 1:1 video in 1.5.2 (owner, 2026-10-30)

**The decision.** 1:1 VIDEO calls ship in 1.5.2, and production is opened to them
(`calls_mode = audio_video`, the owner's action at `/admin/platform`) only after the Tier A video
readings below pass on the Mi 9T AND the iPhone 12. Until then production stays at `audio`
(or `off`), and every 1.5.2 binary carries video that nothing on screen offers.

**What moved, in one commit** (draft PR on `feat/calls-video-production`):

| Moves | File | Asserted by |
| --- | --- | --- |
| `CALLS_VIDEO_ENABLED = CALLS_ENABLED` (it was `deployEnvironment() === 'development'`): a production build carries video exactly when it can call | `frontend/src/lib/features.ts` | `features.test.ts` (the expression, and the value on a dev AND a production build) |
| the camera purpose string names video calls ("pour vos appels vidéo" / "for your video calls"), the microphone one "audio and video calls" | `Info.plist`, `fr.lproj` and `en.lproj` `InfoPlist.strings`, `project.yml` | `callsCompiled.test.ts`: the camera string names calls exactly when a STORE binary carries video, and `project.yml` repeats it |
| **no** Android change: `CAMERA` is already declared (reels, lives); no `camera` foreground-service type, because `installBackgroundHandler` turns the camera OFF when the app leaves the screen (capture stopped) and on again on return, so the microphone service never holds the camera. **Fixed in this PR for Android**: the handler read only `visibilitychange`, which the Android WebView never fires; it now reads `canari:foreground` too ([video](#video-lot-2-2026-10-20---vp8-behind-a-clear-header-held-by-every-transceiver)) | `AndroidManifest.xml` | `androidCallServiceManifest.test.ts` (no `FOREGROUND_SERVICE_CAMERA`, no `camera` type) |
| **no** server change: `ring` already refuses a ring declaring video under `audio` (403 `CALLS_VIDEO_DISABLED`) and allows it under `audio_video` | `calls.service.ts` | `calls.service.spec.ts` ("audio refuses a ring asking for video", "audio_video rings a video call") |

**The client's two locks are unchanged**: the video button and the in-call camera-on control need
`callVideoAvailable(serverCallsMode())`, i.e. the build AND `audio_video`. Under `audio`, a 1.5.2
client places and answers audio calls only. The limit recorded under
[the kill switch](#the-kill-switch---platform_configcalls_mode) still holds: the server judges only
the ring's DECLARED `hasVideo`; an invite carrying `hasVideo` from a modified client is answered with
the camera by a 1.5.2 callee whatever the mode (the camera-off control stays on screen while it
runs).

### A 1.5.x audio-only client against a 1.5.2 client with video

Every stable up to 1.5.1 has `CALLS_VIDEO_ENABLED = false` (B0, #2171). Against a 1.5.2 peer, once
`audio_video` is open:

- **1.5.2 calls 1.5.1 with video**: the ring is allowed; 1.5.1 rings it as AUDIO (`invite ... asks for
  video - this build is audio only, it rings as audio`), answers without a camera, and answers the
  video m-line `recvonly`. The 1.5.2 caller sends its camera and sees the peer's avatar.
- **1.5.1 calls 1.5.2, or the 1.5.2 side turns its camera on mid-call**: the renegotiated video
  m-line is answered `recvonly` by 1.5.1, its frames are DECRYPTED under the receiver transform and
  never shown (`the peer sends video - this build is audio only, it is received and not shown`).
- **The audio is unchanged in both cases - IF the engine feeds a receiver transform whose track has
  no sink.** If it does not, 1.5.1's E2E path check reads video packets with no frame as media AROUND
  the transform and ENDS the call (`CallE2eBypassedError`). Pinned in the unit suite ("judges the
  peer's HIDDEN video"), **unproven on WebKit and on Android System WebView**: that is CALL-L1 row 13
  (readings V2), and it decides the order below. 1.5.1 cannot be changed; only a reading or the floor
  answers for it.
- **What the 1.5.2 user is not told**: the peer does not see them. Their camera is on, their self view
  shows, and nothing says the peer is audio only (no capability is exchanged). Accepted until the
  floor rises; recorded here so it is not reported as a defect.

**DECIDED (2026-10-30): `audio_video` opens only when ONE of these holds** - `minClientVersion` has
been raised to 1.5.2, once BOTH stores serve it (as Q3 did for audio); or VID-6 (CALL-L1 row 13)
reads `PASS` against a 1.5.1 STORE build as the audio-only side, on the iPhone AND on the Mi 9T.
Either way, the readings VID-1..VID-5, VID-7 and VID-8 below pass first. Not to be re-opened.

### The readings owed before `audio_video` opens

On a 1.5.2 pre-release (dev + testers; `CALLS_VIDEO_ENABLED` is true on both ends), each read on
BOTH phones, logs of both ends read, bar `PASS`, never `PASS-DIRTY`:

| # | Reading | Expected |
| --- | --- | --- |
| VID-1 | **K2, Tier A for video**: a 1:1 video call E4<->E1, E6<->E1 and E6<->E4 (Mi 9T app, desktop Chrome, iPhone app), each side dialling once | `video ... VP8`, ~30 fps, freezes 0, `not-vp8=0`, `decrypt-failed=0` both ways, `E2E proven`; the iPhone lists VP8 and has `setCodecPreferences` (else the camera stays off, said) - the "Owed on the phones" table of [video](#video-lot-2-2026-10-20---vp8-behind-a-clear-header-held-by-every-transceiver), readings V3 |
| VID-2 | **K3**: an audio call, then the camera on (renegotiation), each phone being the side that turns it on | the picture appears on the peer, audio uninterrupted, the new m-line's path check conclusive |
| VID-3 | **Camera switch** front/back during a call, on each phone | `replaceTrack` on the same sender; the back camera is not mirrored; a switch that fails turns the camera OFF, said - never a frozen picture |
| VID-4 | **Mute video** (camera off, then on) on each phone | the peer sees the avatar (`remote track muted`), then the picture again; the camera light goes out while off |
| VID-5 | **Background / foreground** mid video call (home, lock), on each phone | `backgrounded - camera off until the app returns (audio continues)`, the voice still carried (B8/B9), `foregrounded - camera on again`, the picture back |
| VID-6 | **Mixed versions** (CALL-L1 row 13, V2): a 1.5.2 build with its camera on against a 1.5.1 STORE build, once with each phone on the 1.5.1 side | 1.5.1 shows no video and the call goes past 30 s; no `CallE2eBypassedError` - or `minClientVersion` raised to 1.5.2 instead (above) |
| VID-7 | **The quality ladder** (VQ, [measuring it](#measuring-it-on-the-phones-owed-device-verification-vq)) | the climb to 720p and the drop under throttle; the phone cost per rung recorded |
| VID-8 | **The camera prompt** on a fresh iPhone install | the system prompt shows the new `NSCameraUsageDescription` naming video calls |

**The texts, written 2026-10-30** (the owner delegated the legal texts: written against the code,
claiming nothing it does not do): `/legal/privacy` ("Appels audio et vidéo", `updated` 30/10/2026)
and register row C21 changed together - the picture E2E like the sound, the camera only inside a
call and off in the background, nothing recorded, `hasVideo` read at the ring and passed in the push
but never stored, the video figures of `[CALL_REPORT]`. The review notes above cover video, with
the rule for a submission made while production is still at `audio`.

**Still owed to the store consoles (the owner's clicks; nothing changed there)** - re-read against
the forms as published that day:

- **App Store Connect > App Privacy**: "Photos or Videos" (is call video, E2E and never stored,
  "collected" under Apple's definition? - the same question as the audio row of the table above,
  now for the picture); "Audio Data" (the same, for call sound); "Other User Content" if the current
  label lists camera content only for posts and reels; "Product Interaction" (call metadata,
  unchanged by video).
- **Play Console > Data safety**: "Photos and videos" (call video, E2E: the encrypted-in-transit and
  E2E exemption read as it stands); "Audio > Voice or sound recordings" (call sound, the same);
  "App activity > Other actions" (call metadata, unchanged). No new permission: `CAMERA` is already
  declared, so no Play permission declaration moves.

## The native ring on the iPhone - PushKit and CallKit (WP-C6, owner 2026-10-22)

**The decision.** The iPhone gets a NATIVE ring like Messenger: a call rings a closed or locked
iPhone on the full-screen CallKit screen, through an APNs VoIP push. It is built behind its own
switch, `CALLS_NATIVE_RING_COMPILED` (`features.ts`, off), in parallel with the audio enablement
(draft #2299 flips `CALLS_COMPILED` and makes the iPhone's FCM ring alert generic meanwhile). The
design-first pull request built everything below that a text test or a unit test can hold, and
flipped nothing. **The flip was made on 2026-10-30** for 1.5.2 - [the native ring
ships](#the-native-ring-ships-in-152-owner-2026-10-30).

**One fact for "this phone takes VoIP pushes": a `voipToken` on its `push_token` row.** The column
exists since WP-XP-5 (migration `010_push_token_voip.sql`), so **no migration and no number is
taken** (chat-delivery's next free one stays where the open pull requests leave it). The token
reaches the server two ways: at `POST /api/mls/push/register` from the TS bridge
(`voipRegistrationField`, `mobile/voipRegistration.ts`), and at `POST /api/mls/push/refresh-token`
from the native `PKPushRegistry` callback (`CanariPersistVoipToken`) when PushKit rotates it. The
field has THREE meanings (`parseVoipTokenField`, `utils/voip-token.ts`): a token; an explicit `null`,
sent by every iPhone binary WITHOUT the ring, which CLEARS the column - so a phone back on a build
without the ring is never sent a push it cannot honour; and absent (an old client, or a ring build
whose PushKit has not answered yet), which leaves it alone. APNs `410` clears it too
(`ringIosVoip`). Not covered: PushKit's `didInvalidatePushToken` deletes the local file but tells
the server nothing - the stale token is cleared by the next `410`; a `refresh-token` that accepts
`null` would close it (owed with the flip).

**How the server sends it: APNs directly, not FCM.** FCM cannot carry `apns-push-type: voip`, so
`ApnsVoipService` (chat-delivery) is the one direct-APNs sender: HTTP/2, an ES256 provider JWT from
an APNs AUTH KEY (`.p8`), topic `fr.emse.canari.voip`, priority 10, `apns-expiration` = the ring's
answer deadline. **What exists**: the sender, its five variables (`APNS_VOIP_KEY_P8`, `_KEY_ID`,
`_TEAM_ID`, `_TOPIC`, `_SANDBOX`) in `docker-compose.prod.yml` AND `docker-compose.dev.yml` (dev's was
missing until 2026-10-30: the secrets were rendered but never forwarded, so the service logged
`APNS_VOIP_* is not configured` and a locked iPhone on dev was not rung; `compose-wiring.test.sh` no
longer allowlists it) and both serve workflows, and the
three production secrets (repository secrets, set 2026-07-23 - names read, never values). **What is
missing**: the three `DEV_APNS_VOIP_*` secrets `serve-dev.yml` reads exist as repository secrets since 2026-10-23 (a missing one makes dev warn and not ring), and any proof that the production key still signs (no VoIP push was ever
sent). A key is team-wide: no VoIP certificate is needed with token auth. **`APNS_VOIP_SANDBOX`
stays unset on dev too**: a TestFlight build is signed `aps-environment production` and its tokens
belong to the production gateway; only an Xcode debug build needs the sandbox.

**Apple's hard rule, and what it decides.** Since iOS 13 EVERY VoIP push must report a CallKit call
before its completion handler returns; an app that does not is killed, and repeated misses stop
VoIP delivery to it. So the rule is split in two:

| Case | The server (never sends the push) | The phone (reports whatever arrives) |
| --- | --- | --- |
| `calls_mode` `off` (or video asked under `audio`) | `ring` refused before any fan-out (`assertCallsOpen`) | - |
| A block between caller and callee | `ring` refused (`refuseIfBlocked`) | - |
| The callee refused calls here, or the conversation is at `none` with no choice made | not in the fan-out (`membersWhoTakeCalls`, `callsAllowedFor`) | - |
| The ring ended (`ring-end`: answered, cancelled, ended) | withheld: `ring-end` writes `call:room:<id>:ring_ended` for a room of ITS group, read before each device (`liveRingDeadline`) | a push that crossed it rings until `call_ring_end` or the deadline |
| The answer window closed | withheld (`answer_by` in the past) | a push held by APNs and delivered late: reported and ENDED at once (`ringUntil` past) |
| A binary without the ring | no token (cleared by its explicit `null`) | - |
| The APNs key missing | the device is NOT rung, ERROR once per fan-out - no FCM alert in its place | - |
| A malformed or unknown payload | - | reported and ended at once |

The phone's half is `CanariReportVoipCall` (`canari_push.mm`): synchronous on the registry's main
queue, before `completion()`; a call already rung by the FCM `call_ring` is reported again under the
same UUID (CallKit refuses the duplicate, which still honours the contract, and nothing new rings). A
call not to ring (deadline passed, app in the foreground) is ended inside the report's completion.

**The name: never in the push.** The VoIP payload is `{type, groupId, callId, callerId, hasVideo,
ringUntil}` (`voipRingPayload`, `call-ring-payload.ts`, its key set pinned by a test) - ids and the
server's deadline, never `callerName`/`groupName` (decision 6). The phone writes the caller on the
CallKit screen from ITS copy of names (`display_names.json`, under the owner rule a mention uses -
`CanariCallerDisplayName`), and "Appel Canari" / "Canari call" (`notif.call.unknown_caller`) for a
caller it never named. APNs still sees the two ids and the timing: pseudonymous metadata, the same
level as every message push. The Android `call_ring` data carries ids only too since 2026-10-30
(`{type, groupId, callId, callerId, hasVideo}`), named the same way on the phone.

**Ring timeout and ring-end.** The ring ends at the earliest of: the server's answer deadline
(`ringUntil`, capped at the native 60 s) - so the phone never rings past the window `room-token`
enforces; `call_ring_end` (FCM, `content-available`, priority 5, `CanariHandleBackgroundFrame`);
the MLS `call_hangup` once the app runs; the user's decline (local only, as on Android). **Named
limitation**: Apple throttles priority-5 background pushes, so a CANCELLED call may ring on a closed
iPhone until its deadline. To measure on the bench (K7) before anything is built; if it is bad, the
remedy is a `PushSecret`-authenticated ring-state read by the ringing call, never a VoIP push for
the end (each one would have to report a new call).

**Answering from the lock screen, and the audio hand-off.** CallKit's answer cannot start audio:
the MLS keys are behind the app's PIN in the web view. The answer writes `pending_call_accept.json`
and opens the conversation's plain link (navigation only); from the lock screen the user unlocks
(Face ID), opens Canari from CallKit's button, enters the PIN; the web view drains the accept and
joins once the session has caught up, with no invite awaited
([below](#an-answer-from-the-ring-joins-on-the-rings-facts-2026-10-30)). On `didBecomeActive` the CallKit call is ended (`AnsweredElsewhere`), so
WebKit owns the audio session from then on, and the `audio` background mode (`CALLS_COMPILED`)
keeps the call alive when the phone locks again (WP-C-BG-I). Cost, accepted by this design: the
caller hears it ring until the callee has unlocked, inside the 60 s window; Messenger connects at
once because its keys are not behind a PIN. Keeping the CallKit call for the whole call (the green
pill, the system in-call screen) means handing CallKit's `didActivateAudioSession` to WebKit, which
nothing here has measured - a later lot.

**Declarations.** `voip` in `UIBackgroundModes` (the flip; `audio` comes with `CALLS_COMPILED`,
`remote-notification` is there). **No new entitlement**: PushKit and CallKit need none; the App ID
keeps its Push Notifications capability (`aps-environment production`). App Review: the 2.5.4
refusal of 2026-08-31 is answered by a build that rings - the review notes and video show a locked
iPhone ringing. CallKit is not allowed on the China mainland storefront.

**The flip, ONE commit: MADE on 2026-10-30** - the next section.

**Uncompiled**: the Objective-C of this lot was written on Windows and is held only by
`nativeRingVoip.test.ts` (text) until the iOS CI job compiles it and K6/K7/K8 run it.

## The native ring ships in 1.5.2 (owner, 2026-10-30)

**The decision.** After the first production call (an open app only), the owner decided that the
native incoming-call screen ships in 1.5.2: a call rings a closed or locked phone full screen, as
WhatsApp does. The five switches moved in ONE commit; `callsCompiled.test.ts` asserts they agree.

| Switch | File | What it does when on |
| --- | --- | --- |
| `CALLS_NATIVE_RING_COMPILED` | `features.ts` | the fact the others mirror; the iPhone sends its PushKit token at `push/register` instead of an explicit `null` (`voipRegistrationField`) |
| `CALLS_ENABLED` | `CanariFirebaseMessagingService.kt` | a `call_ring` FCM data push raises the CallStyle ring on the `canari_calls` channel instead of being dropped (a decrypted MLS `call_invite` never rings, switch or not) |
| `USE_FULL_SCREEN_INTENT` | `AndroidManifest.xml` | lets that ring open `IncomingCallActivity` over the lock screen; without it Android shows a heads-up banner only |
| `kCanariCallsEnabled` | `canari_push.mm` | installs the `PKPushRegistry` and the `CXProvider` at process start; `CanariReportIncomingCall` reports to CallKit instead of returning |
| `voip` | `Info.plist` + `project.yml` `UIBackgroundModes` | the only way PushKit hands out a token; App Review checks it is used |

**Owner, 2026-11-01:** the incoming-call screen is in-app plus Android full screen, with the same
design; the live end keeps its red X, since a confirmation modal exists.

**What moved with them.**
- **Android's full-screen intent opens a SCREEN, never the answer.** Android launches a full-screen
  intent BY ITSELF on a locked or idle phone, and it used to be the answer deep link - every call to
  a locked phone would have been answered with nobody touching it. It is now `IncomingCallActivity`:
  the caller's photo and name over the lock screen, Decline and Answer. Answer asks the keyguard to
  go first (`requestDismissKeyguard`), then sends the notification's own answer intent. **The screen
  never outlives its ring**: it closes with it (`cancelIncomingCallNotification` -> `finishFor`, and
  `cancelAllMessageNotifications` on the app's resume); a launch that lands after the ring ended
  (between `notify` and `onCreate`) asks `isRinging` and closes at once; and the screen bounds
  itself by the ring window (`CALL_RING_TIMEOUT_MS`). A second call while it shows (`singleTop`)
  replaces it through `onNewIntent` - unless that call no longer rings, in which case the first
  call's screen stays while its call still rings. Answer sends its intent with a background-start
  mode (`ALLOW_IF_VISIBLE` on API 36+, `ALLOWED` on 34-35), without which Android 14+ may block the
  app's launch. On Android 14+ the ring logs `canUseFullScreenIntent()`, the permission the user (or
  Play) may have withheld.
- **The ring is the server's `call_ring` alone.** The decrypted MLS `call_invite` branches (Android
  and iOS) rang past `calls_mode`, the conversation's permission, the video rule and blocks; they
  are deleted and log the drop. So is the notification extension's ringing banner for an invite
  pushed as an alert (only an old or crafted client sends one; current callers send it silent): it
  is delivered blank, as a control event is.
- **An open iPhone rings once.** A VoIP push that reaches an app in the foreground whose page holds
  the gateway socket (the overlay already rings) is reported to CallKit and ended at once - Apple
  requires the report, and a second ring on top of the overlay is what it would otherwise be. An app
  in front at the PIN gate holds no socket and rings on CallKit
  ([below](#an-open-app-at-the-pin-gate-rang-nothing-153-2026-10-31)).
- **Names come from the phone, never the payload** (decision 6), on both platforms: the server's
  `call_ring` data is ids only; Android names the caller from `display_names.json`
  (`knownCallerName`), iOS from the same file (`CanariCallerDisplayName`) on both CallKit paths -
  the VoIP push and the FCM ring of an iPhone with no VoIP token. A caller the phone never named is
  "Appel Canari" / "Canari call", and shows no photo either.
- **The caller's photo** is on the ring notification (the `Person` icon and the large icon, re-posted
  once read while the ring is still live) and on the call screen, for a NAMED caller only. The ring's
  60 s end is armed before the photo is fetched, so a slow fetch never delays it. It is CACHE FIRST: the 24 h file
  cache every message notification fills (and its remembered "no photo"), the push-secret avatar
  route only on a miss. CallKit cannot show a third-party photo; the iPhone shows the name only.

**Verified by compiling, never by running:** the Android Kotlin (`:app:compileArm64DebugKotlin`) and
the merged manifest (`:app:processArm64DebugMainManifest`); the server spec (70 tests). **The
Objective-C was not compiled at all** (written on Windows; the iOS CI job is its first compiler).

**Readings owed before the stable** (calls-revival-plan K6/K7/K8):

| Row | Mi 9T | iPhone 12 |
| --- | --- | --- |
| K7 - app KILLED, phone unlocked: it rings, with name and photo | the CallStyle ring + call screen | the CallKit screen, name only |
| K8 - phone LOCKED: it rings full screen; Answer asks the unlock, then joins | `IncomingCallActivity` over the keyguard, nothing answered until a tap | CallKit, Face ID, the app PIN, then the join |
| K8b - the caller cancels: the screen goes away | within seconds (`call_ring_end`) | the named limitation: may ring to the deadline |
| K6 - screen locked mid-call keeps the audio | the call service | the `audio` mode |
| Logs | `IncomingCallActivity` and `canUseFullScreenIntent` lines | `[CanariCallKit] voip credentials updated`, `ringing call=` |

**Operator actions (the owner's):**
- **Play Console**: Android 14+ grants `USE_FULL_SCREEN_INTENT` by default only to calling and alarm
  apps; the App content -> Full-screen intent declaration must say "calling". Without it the ring
  degrades to a heads-up banner (the log line says so).
- **App Review**: the 1.5.2 notes answer the 2.5.4 refusal of 2026-08-31 - Canari places audio calls,
  and a VoIP push rings a locked iPhone on CallKit; attach a video of it.
- **Dev secrets**: the three `DEV_APNS_VOIP_*` repository secrets, absent, so a pre-release on dev
  rings no VoIP device (the FCM generic alert does not stand in for it).
- **No new Apple entitlement and no VoIP certificate**: PushKit and CallKit need none, and the `.p8`
  auth key is team-wide. The production key has never sent a VoIP push: the first K7 proves it signs.

**Still open:** `didInvalidatePushToken` tells the server nothing (the next APNs `410` clears it);
a VoIP-pushed ring is announced as audio (`hasVideo = NO`) until the video lot decides otherwise.

### An answer from the ring joins on the ring's facts (2026-10-30)

**The defect (1.5.2-alpha.1, Mi 9T, K7 killed and K8 locked).** The ring rang, Answer opened the
app, and the call never connected: both sides ended on "Appel sans réponse". The caller's MLS
`call_invite` is a TRANSPORT frame, and chat-delivery hands a transport frame only to a device online
when it is sent (`TRANSPORT_SKIPPED_OFFLINE`: no row, no push). A phone the native ring reached was
closed by construction, so the invite never reached it - and the answer waited for that invite
(`consumePendingCallAccept`, read only on the invite path) until its 2 min expiry. The iPhone's
CallKit answer took the same path.

**The design: the answer is the whole answer.** Nothing the invite carries is needed to join:
- the conversation, the call, video and the caller came with the server's `call_ring`, and ride the
  answer;
- every rule the invite's admission applies in the app (`calls_mode`, the conversation's permission,
  blocks) the server applied before it rang;
- the room token `acceptCall` asks for first applies them AGAIN and is the authority on lateness: a
  closed window, or a ring the server already recorded as ended (`cancelled`, `answered`, `ended`:
  `call:room:<id>:ring_ended`), is its `410`; a block set since is its refusal - an answer from the
  server, not a guess.

**The native answer is carried by a private intent, never a public URL.** The answer's facts are
the RING'S, recorded natively when it rang, and reach the web view through ONE door,
`pending_call_accept.json`, drained by `read_and_clear_pending_call_accept` (the same command on both
platforms, at mount, on a signed-in resume, on a visible resume still at the PIN gate, and on iOS
when the native handover says an answer waits, `canari:call-accept` -
[below](#the-iphones-answer-never-joined-and-its-decline-never-left-152-alpha2-2026-10-31)):
- **Android** (`CallRingAnswer.kt`): the ring records its facts (group, call, caller, video, the
  instant it rang) under a per-ring nonce in app-private preferences; the Answer intent carries only
  the call id and that nonce as extras, its data the plain conversation link. `MainActivity`
  (`onCreate` on a fresh launch, `onNewIntent`) checks the nonce, forgets the record and writes the
  file from the RECORDED facts with the instant of the tap, atomically. A dismissed or ended ring
  forgets its record (`cancelIncomingCallNotification`, `cancelAllMessageNotifications`).
- **iOS**: CallKit's answer writes the file natively; the link it opens is navigation only.
- **A link navigates and never answers**: `hooks.client.ts` reads no answer from a URL, whoever
  opened it (a parameter that looks like one is logged and ignored).

`pendingCallAccept.ts` then HOLDS the intent until the session has caught up and acts on it once.
"Caught up" is a named signal, `ConnectionDeps.onCaughtUp`, fired by `openGatewayConnection` after
the post-connect catch-up (`settleUnresolvedCommits` then `fetchPendingMessages`), never on the
socket merely opening - so the join derives its keys from a group that has absorbed what was queued.
A closed socket clears it, and the next catch-up acts on what is held. The file carries the native
instant of the tap (`acceptedAt`); an entry without one is no answer, so a replayed intent is never
stamped fresh on drain.

`CallService.answerFromSystemSurface` takes the intent and joins: the same call already past
`incoming` (a duplicate answer) - nothing, logged at debug; already ringing the same call (the invite
did arrive) - accept it; the ENDED summary - cleared first; in another call - dropped, logged WARN
(only the user may drop a live call); otherwise the call's facts are set, the state is `incoming`,
and `acceptCall` runs. An invite that does arrive afterwards meets the call it already is
(`yieldToOrAnswerBusy`: same callId, ignored).

**One clock exists, and it decides nothing the server decides.** `MAX_PENDING_AGE_MS` (2 min from
the native tap) bounds how long a held tap may wait for a session that never catches up; whether the
call can still be joined is the room token's answer alone. A sibling device answering after this one
gets the `410`: the answering device asks for its token BEFORE it ends the ring as `answered`.

**Two shapes rejected.**
- *The answering device asks the still-ringing caller to resend the invite.* A new proto frame, a
  round trip before the join, and callers on any earlier build never answer it - for an invite whose
  content the callee already holds.
- *The server keeps the invite for exactly the devices it rang.* The server would have to classify a
  ciphertext as an invite (it cannot read it) or take a new per-device durability flag, and a stored
  invite outlives its call unless something else expires it - a second ledger for what the ring
  already said.

**Covered by** `CallService.p2p.test.ts` ("an answer on the native ring, no invite ever delivered":
the real gate and the real `acceptCall` - room token first, then the answered frame and the socket;
a `410` toasts and starts nothing; a duplicate starts nothing), `CallService.answerFromRing.test.ts`,
`pendingCallAccept.test.ts` (held until the catch-up; no instant, no answer; a link never answers -
only the native drain records one), `initializeConnection.test.ts` (the catch-up signal fires after
the settle and the fetch), `calls.service.spec.ts` (the `410` once the ring ended, the sibling case)
and the text pins in `incomingCallScreen.test.ts` (the nonce, the private file, no answer in a link).

### A decline on the ring reaches the caller (2026-10-30)

The native Decline (`CanariNotificationActionReceiver.handleCallDecline`, which `IncomingCallActivity`
fires too, and CallKit's `performEndCallAction`) only stopped the local ring: the caller rang its whole
minute. It now sends the frame the in-app Decline sends - `CallMsg { hangup, end_reason = DECLINED }`
(`build_call_hangup_app_message`, `proto_fields.rs`), encrypted by the background MLS path and posted
ONCE (`sendTransportFrameNow` / `CanariSendCallDecline`): silent, not durable, never through the
outbox mirror, because a hangup replayed after its call ended means nothing. A failure is logged and
the caller rings out, as before. Calls are 1:1 (lot 1), so declining and ending the caller's ring are
one act.

**On iOS an End after Answer ends the call for real.** CallKit's End on a call already answered
removes `pending_call_accept.json` if it names that call (`CanariCancelPendingCallAccept`), so the web
view joins nothing later, and sends the same hangup. No in-memory intent can exist to cancel: the
page is told of the file only at the handover, queued behind the `AnsweredElsewhere` ends that
activation makes (`CanariTellPageOfPendingCallAccept`), so no End can follow a drain.

**The background MLS model the decline inherits.** It is the quick-reply send path, unchanged:
`encryptQueuedMessages` -> `send_messages_background_with_key` under the MLS state lock, the state
saved BEFORE any ciphertext leaves, a group whose staged commit is unsettled held (`commit-pending`).
Two consequences, both a DROP and never a queue: a held group, or a save refused because the
foreground guard is live (`background_write_mls_bin_compare_and_swap` refuses while the foreground
heartbeat is fresh, the whole batch discarded), sends no decline - logged, and the caller rings out
its window. A queued hangup could outlive its call, which is why none is queued.

**Not covered:** the callee's OTHER devices still ringing natively keep ringing to the window
(`ring-end` needs a session token a receiver does not hold); an in-app sibling stops on the hangup,
and a sibling's later answer is refused by the room token (`410`).

**Owed on hardware:** K7/K8 Answer joins on the Mi 9T (including a process death between the ring
and the tap) and on the iPhone (CallKit); an Answer from a warm app still at the PIN gate; CallKit
End after Answer joins nothing and ends the caller's call; Decline from the Android ring and from
CallKit ends the caller's ring at once and files "declined". The Objective-C and the JNI/FFI are
uncompiled here (the iOS CI job is the Objective-C's first compiler).

### The iPhone's answer never joined, and its decline never left (1.5.2-alpha.2, 2026-10-31)

**The readings** (iPhone 12 on TestFlight `1.5.2-alpha.2`, dev, the Mi 9T calling on alpha.1).
K7 (app killed, Answer on CallKit, then the PIN) and K8 (locked, slide to answer, Face ID, the PIN)
both landed on the feed: the server saw the device come online and no call-service socket nor room
token for the call, which rang out `cancelled`. The CallKit Decline of a killed app, and the End
right after an Answer, logged `encryptQueuedMessages: ok=false` and the caller rang its minute.

**One fact behind both: PushKit launches a killed app in the background, and WKWebView loads its
page `visible` and keeps it so.** The syslog shows it every time: `view visibility state changed
0 -> 1` at the launch, `setIsInBackground: 1` 50 ms later with no change back, and the next
visibility change only when the app, having been active, left (`1 -> 0` at 02:55:03 in K7). So:
- **No drain after the Answer.** The page mounted 1.5 s after the PushKit launch, before the ring;
  the Answer wrote the file 30 s later and the app came to the front, and no `visibilitychange`
  fired - the two resume drains never ran. The file sat on disk until the NEXT process's mount
  drained it, minutes stale (FSEvents: written 02:53:15, read 03:02:02). In `1.5.2-alpha.1` the
  Answer's deep link carried `acceptCall`, and `onOpenUrl` fires whatever the visibility: #2765 made
  the link navigation-only, which removed the one trigger that did not depend on a transition. Not
  a regression from 1.5.1, where CallKit was compiled out.
- **The decline's write refused.** At the PIN gate the page's 10 s foreground heartbeat ran (it is
  paused only by `hidden`), so the guard was always fresh, and `background_write_mls_bin_if_unchanged`
  refused the hangup's ratchet save; a batch whose save is refused hands out no ciphertext. The MLS
  state is NOT sealed behind the PIN: the background copy of the device key is in the Keychain
  (`AfterFirstUnlockThisDeviceOnly`), exactly what the extension and the quick reply use. Rust's
  reason does not reach the syslog, so this is read from the timings (the guard lives 30 s; the
  decline came 12 s and the End 10 s after the launch's mount) and the absence of every other cause's
  line; the native line now carries Rust's reason.

**The fix, at each cause.**
- **The native side tells the page at the handover.** The `didBecomeActive` observer that ends every
  CallKit call `AnsweredElsewhere` then queues, on the same main queue, `CanariTellPageOfPendingCallAccept`:
  if the file exists (a stat), the page gets `canari:call-accept` and drains it
  (`listenForNativeCallAccept`, `pendingCallAccept.ts`; a repeated event reads an emptied file); a
  page not loaded yet drains it at mount. NOT at the Answer: until the app is active a CallKit End
  may still cancel the answer, and the page must not hold it then. "The page was told" is logged in
  the completion handler, once the page ran the dispatch. Android tells a live page the same way
  when `MainActivity.onNewIntent` takes an answer (`pushCallAccept`): a warm activity already
  visible at the PIN gate sees no visibility change either.
- **The heartbeat holds the guard only over a loaded manager** (`heartbeat_foreground_guard`,
  `concurrency.rs`). The guard protects the state a foreground manager holds in memory; before a
  login there is none, and the login's read marks the guard itself first. Whether a manager is
  loaded is a fact this process holds (`live_manager_flag`), where `visibilityState` is the
  WebView's opinion. No change for a signed-in page.

**A server-side typed decline was weighed and not taken.** The hangup CAN be sealed without the PIN
(the background key above), so a second, cleartext path for the same act would be a fallback beside
a primary path that works, and one more fact handed to the server in clear.

**CallKit shows the answered call as connected ("Canari audio - 00:03") while the caller still
rings: accepted.** `CXAnswerCallAction` is fulfilled at once. The join waits on Face ID, the open
and the PIN - an unbounded human step - and an action left unfulfilled is failed by CallKit on its
own deadline, which would end the call under the user; the screen is the callee's own, the caller's
ring is true, and the handover ends the CallKit call the moment the app is in front.

**Named limitations.**
- A page that MOUNTS between the Answer and the activation (a launch slower than the ring) drains
  the file at mount, so an End in that window removes the file but not the held answer. Not
  observed: the page mounted 1.5 s after each launch.
- **A launch that signs in by itself still refuses the Decline.** Biometrics with no prompt due, or
  "stay signed in" on a hardware-held key, load a manager in the background; that page holds the
  guard, correctly, and the hangup's write is refused (`ok=false (... foreground active ...)`). The
  fix is to send the decline through the loaded manager
  ([backlog](../../backlog.d/p2-a-callkit-decline-is-still-refused-for-a-user-whose-launch-signs-in.md)).
  And with the guard released at the PIN gate, an old-PIN recovery's blind install can erase a
  background write made during its PIN check
  ([backlog](../../backlog.d/p2-an-old-pin-recovery-installs-bytes-it-read-before-the-pin-check-wit.md)).

**Owed on the iPhone** (TestFlight with this change, against dev, **the app unlocked by its PIN -
neither biometrics nor "stay signed in"**, which sign in in the background and are the limitation
above; one more Decline reading with each of those names it): K7 and K8 join after the PIN -
`[CanariCallKit] an answer waits - the page was told`, then a room token for the call and the
call-service socket on the server; the Decline of a killed app ends the caller's ring at once -
`decline call=... sent=1` and the caller's record `declined`; the End right after an Answer joins
nothing AND ends the caller's ring the same way. Any `ok=false` now names its reason.

### An open app at the PIN gate rang nothing (1.5.3, 2026-10-31)

**The reading** (Mi 9T, a local debug build of `1.5.2-alpha.3`, dev). Canari open in front, on the
PIN keypad: the server's `call_ring` arrived and was dropped by the foreground guard of
`onMessageReceived` (`App in foreground -> MLS handled by the foreground (WS), skip background
processing`, which exempted only `form_reminder` and `social`), and `showIncomingCallNotification`
had a second `isInForeground` return behind it. The page logged `[CallView] held under the PIN lock`
and nothing else: the callee saw the keypad while the caller rang out. In production since 1.5.1.

**The cause: "the app is in front" was read as "the page rings".** The page rings from the caller's
MLS `call_invite`, a transport frame the server hands only to a device whose gateway socket is open
when it is sent (`TRANSPORT_SKIPPED_OFFLINE`). The socket opens after the unlock (`[WS] Opening
connection` follows `Salt asked while the keypad was up`), so a page at the PIN gate is offline to
the server: no invite, no in-app ring - and the native ring stood back for it anyway. The iPhone had
the same two standbys (`CanariReportVoipCall` ended a VoIP push at once, the FCM `call_ring` branch
returned, both on `canari_ios_is_in_foreground()`).

**The fact carried instead: whether the page holds the gateway socket** (`page_ring.rs`). The page
states it at the one seam that holds its socket - the setter of `TauriMlsService.ws`, which every
open, close, pause, zombie kill and `pagehide` release already goes through - with the synchronous
command `set_page_gateway_socket`; a change is reported, a repeat is not. Each `TauriMlsService`
instance states it under its own holder id, and the page rings while ANY holder holds a socket: two
instances that overlap (an account switch) cannot erase each other's statement. A document that
starts loading voids every statement (`on_page_load`, `PageLoadEvent::Started`): a new page holds no
socket, whatever the last one said or failed to say; on iOS a dead web content process clears them
too, before the reload its handler asks for (`on_web_content_process_terminate`). The native ring
reads it next to the platform's own fact:
`foregroundPageRings()` (Kotlin, `isInForeground && nativePageRingsInApp()`) and
`CanariForegroundPageRings()` (Objective-C, through `canari_ios_page_rings_in_app`). The foreground
guard of `onMessageReceived` lets `call_ring` through - a ring touches no `mls.bin` - and the ring
itself is the one place that decides. So:
- **a signed-in page in front** holds the socket: the native ring stands back and the overlay rings
  from the invite - one ring, as before;
- **a page at the PIN gate** holds none: Android posts the CallStyle ring (a heads-up on a phone in
  use), the iPhone reports to CallKit and leaves it ringing. Answer goes through the private answer
  of [the ring's facts](#an-answer-from-the-ring-joins-on-the-rings-facts-2026-10-30): on Android
  `MainActivity.onNewIntent` takes it and tells the live page (`canari:call-accept`), which holds it
  until the unlock's catch-up; Decline sends the hangup through the background MLS path;
- **an app in the background** rings natively, unchanged.

**Two facts weighed and not taken.**
- *A loaded MLS manager* (`live_manager_in_process`, what the heartbeat guard of #2782 reads). It
  answers whether there is foreground memory to protect, and it outlives its page: the same logcat
  shows a full document load over a warm manager (09:53:23, a navigation to `/chat`) drawing the PIN
  gate at 09:53:25 with the manager still loaded. That page holds no socket and would have rung
  nothing.
- *An in-app ring at the gate with the answer held until the unlock.* The page has nothing to ring
  from - the invite never reached it - so it would need the push handed up to it, and a second ring
  surface for a case the native ring already covers with its answer, decline and caller name.

**The iPhone answers from an active app.** CallKit answered while Canari is already active is
followed by no `didBecomeActive`, so the handover (`CanariHandOverCallsToPage`: end the ANSWERED
CallKit calls `AnsweredElsewhere`, then tell the page) runs from `performAnswerCallAction` itself
when the app is active, after the file is written. Not observed on hardware: whether iOS resigns the
app while its CallKit UI is up. If it does, the activation runs the handover a second time, and that
run finds the answered call already ended and the file drained.

**The handover never ends an unanswered ring the page cannot ring** (review of #2785). It used to
end every CallKit call on `didBecomeActive`. With CallKit now ringing an app in front at the PIN
gate, that ended the call's only ring whenever the app re-activated without an answer: a pull of
Control Center or Notification Center, an expanded banner swiped back, or Canari opened from its
icon while a backgrounded app rang. An unanswered call is ended there only when the page holds the
gateway socket (the overlay owns it); otherwise it rings on, to its answer, decline, `call_ring_end`
or timeout.

**An End between the handover's end and the tell cancels the answer.** The handover ends an
answered call asynchronously, which removes its ringing entry, and tells the page after. A user's End
landing in between used to find no entry, cancel no file, and let the tell hand the answer over. The
answer's facts are now kept past the ringing entry until the tell has run
(`CanariAnsweredUntilTold`), and the End reads them there.

**Named limitations.**
- **A socket counted as held that rings nothing.** The statement is "the page holds an open socket",
  not "the invite will ring". A connection that died without a `Close` counts as held until the
  heartbeat kills it (three missed pings, up to ~30 s), and the server, which considers the device
  offline, skips the invite. An invite at an epoch the page cannot decrypt yet (a commit still to be
  absorbed) reaches the page and rings nothing. In both cases the native ring stood back and the call
  rings nowhere: the gap this fix closes, narrowed to those two states.
- **The narrow double-ring windows.** Two windows: a socket that opens between the push and the
  invite (the unlock below), and an invite that reaches a page whose socket is released just after the
  push stood back. In either, one call may show two ring surfaces, or none, for the length of the
  overlap. The answer covers the double: either surface's answer joins the same call, and its ring-end
  stops the other.
- **The unlock that races the ring.** A PIN entered between the `call_ring` push and the caller's
  invite (sent right after the ring is accepted) opens the socket in time for the invite: the overlay
  rings over a native ring still showing. Both are the same call: the first answer joins it
  (`answerFromSystemSurface` accepts a call already ringing in the page), and the answer's ring-end
  stops the other. Not observed; the window is the invite's latency after the ring. On the iPhone the
  CallKit ring is now ended as the page starts ringing
  ([below](#the-handover-ends-an-unanswered-ring-only-when-the-page-rings-that-call-2026-10-31));
  Android keeps both until the answer.
- **A page at the gate over a warm manager still refuses the native Decline**: the heartbeat holds
  the guard for a loaded manager, as on the iPhone's self-signing launch
  ([above](#the-iphones-answer-never-joined-and-its-decline-never-left-152-alpha2-2026-10-31)); the
  caller rings out its window.

**Covered by** `page_ring.rs` (the statement, the page load that voids it),
`pageGatewaySocket.test.ts` (the command, a refused report logged, the setter reporting changes
only) and the text pins of `incomingCallScreen.test.ts` (the guard lets `call_ring` through, both
platforms stand back on the page's fact alone, the iPhone's active-app handover). **The Kotlin is
not compiled by any gate here and the Objective-C not at all** (the iOS CI job is its first
compiler).

**Owed on hardware.** Mi 9T, Canari in front on the PIN keypad: the call rings (heads-up) -
`app in front with no socket (PIN gate) -> the native ring is the only one`; Answer, then the PIN:
`call answer waits - the page was told`, then a room token and the call; Decline: `decline call=...
sent=1` and the caller's record `declined`. Mi 9T signed in and in front: ONE ring, the overlay -
`the page in front holds the socket -> it rings in-app, skip`, and no CallStyle notification. The
iPhone, in front at the gate: CallKit rings - `voip push with the app in front and no socket`; Answer
logs `handover to the page (answered with the app already active)`.

### The handover ends an unanswered ring only when the page rings that call (2026-10-31)

The second review of #2785 left four P3s, and the review of #2794 five more; all are closed here.

**"The page holds a socket" is not "the page rings this call".** The handover judged an unanswered
CallKit ring by the socket fact, which answers a different question: *will the page ring a call that
arrives now*. A call rung by CallKit at the PIN gate had its invite skipped; the PIN unlock then opens
the socket, and that page rings nothing. A re-activation in that state (Control Center, a banner)
ended the call's only ring. The page now states a second fact, from where it is known: the call its
`CallService` is `incoming` on (`set_page_ringing_call`). It is re-judged on every move of
`callState` AND every write of `currentCallId` (a setter), so it holds whatever order the two are
written in; a change is reported, a repeat is not. The handover ends an unanswered ring only when
`canari_ios_page_rings_call(callId)` says the page rings THAT call; the socket fact still decides
whether the native ring stands back when a push arrives, before any invite exists. Each
`CallService` instance states under its own holder, like each `TauriMlsService`, and one replaced at
an account switch withdraws its call and stops reporting (`retireFromPageRing`, called by
`useChatSession.initServices`).

**A ring the active page takes over ends its CallKit twin.** The handover runs on an activation, and
an app already active sees none: a call rung by CallKit while the page had no socket, then by the
page (the unlock came in time for the invite), rang twice. When `set_page_ringing_call` records a
call the page STARTS ringing, Rust calls the listener `CanariPageStartedRinging`, which copies the id
and, on the main queue, with the app active, ends that call's UNANSWERED CallKit ring
`AnsweredElsewhere` - as the handover would. An answered call is the handover's; an inactive app is
judged at its activation. The listener is REGISTERED by `CanariCallKitSetup`
(`canari_ios_set_page_ringing_listener`), never linked: the Rust library is linked into the
notification extension too, where `canari_push.mm` is not.

**A statement from a previous document is ignored.** A `set_page_gateway_socket(.., true)` sent by
the old document and still in flight across a navigation commit used to land after
`forget_on_page_load` and leave a holder nobody would ever withdraw - a page at the PIN gate counted
as ringing, #2785's no-ring again. Every page load (and a dead web content process) moves a document
generation on; the page asks it AS ITS MODULE LOADS (`page_ring_document`, in Tauri), while that
document is surely the current one - asked lazily, an old page's first ask could cross a reload and
learn the new generation. Every statement names it and waits behind the ones before, so the order
holds while the ask is pending; a statement naming another generation is logged and ignored. A
failed ask is said and asked again at the next statement: the module dies with its document, so any
answer is this document's own.

**A record no longer outlives its call.** `CanariAnsweredUntilTold` kept an answered call's facts
until the tell; a call answered in the background and then ended by `call_ring_end`, by an MLS
hangup or at its deadline, before the app became active, left its record behind. Only the
handover's own end keeps it now (`CanariEndCallKitCallFor(.., YES)`); every other end drops it, since
CallKit sends no End for a call it already ended.

**An answered call is never ended `Unanswered`.** The ring's deadline ended a call answered on
CallKit as `Unanswered` when the app had not been made active in time. By reading, not by
observation: `Unanswered` names a call nobody took, and the phone's Recents likely files it as
missed. The deadline is the server's `ringUntil` on the VoIP ring, and a LOCAL 60 s from the report
on the FCM ring (`kCallRingTimeoutSec`), which only approximates the server's. Such a call is ended
`Failed` now (`CanariEndCallKitCallAtRingDeadline`): past the server's deadline its join is refused
(`room-token` 410), and a session left open would hold a green bar for a call nobody can join. Its
pending accept is kept, so the page, once opened, joins if the server still lets it and otherwise
says the call is over.

**Covered by** `page_ring.rs` (the holder sets, the ringing call, a stale document ignored, the
generation's wrap, the listener told once per call the page starts ringing), `pageGatewaySocket.test.ts`
(the generation asked at load in Tauri and not in a browser, named in every statement, the order kept
while it is asked, a failed ask asked again), `CallService.pageRing.test.ts` (the call named on
entering `incoming` and withdrawn on leaving, the id followed whichever is written last, an outgoing
call never, two services two holders, a retired service withdrawing and silent, nothing in a
browser) and the text pins of `incomingCallScreen.test.ts` for the Objective-C, which no gate here
compiles. **Owed on hardware** (iPhone):
- at the gate with CallKit ringing, PIN entered, then Control Center pulled -
  `still rings unanswered and the page does not ring it - kept`;
- at the gate with CallKit ringing, PIN entered fast enough for the invite to ring the page -
  `now rings in the active page - its unanswered CallKit ring is ended`, one ring left;
- answer on CallKit and do not open the app for more than 60 s: what CallKit's UI and the Phone
  app's Recents show (`answered but not taken over by the page by the ring's deadline`).

## Lot 1 (2026-10-17) - 1:1 audio, peer to peer, dev builds only

**What it is.** The user's 2026-10-16 decision made concrete: a 1:1 call goes DIRECT between the
two clients, with Cloudflare TURN as the last resort, and the host carries only signalling over the
443 it already serves. The host cannot send UDP out (the School border), so the SFU path can never
connect from production ([realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md#8-what-works-with-no-port-opened-by-the-dsi-measured-2026-10-16)).
Nothing in this lot needs the DSI.

**The call keys and the group's epoch (2026-10-22).** Each end derives the media keys from the
conversation's CURRENT MLS epoch (`setupEncryption`), the caller before the ring and the callee after
the answer, so an epoch move in between gives the two ends different keys. `CallService` holds the
periodic leaf refresh of its call's group from leaving `idle` until the call is over
([mls-protocol](../../protocols/mls-protocol.md#the-periodic-leaf-refresh)). It holds only THIS
device: another device or another member can still move the epoch while a call is being set up - the
class `onUndecryptable` reports. Calls are dev builds only, and that is accepted for now.

**The switches** (`frontend/src/lib/features.ts`, pinned by `features.test.ts`):

| Constant | Value | Holds |
|---|---|---|
| `CALLS_COMPILED` | `true` (since the flip PR, 2026-10-22) | the store binaries' calling WITHOUT the native ring (since 2026-10-21, B2'): in-app calls, `audio` (since 2026-10-20), the microphone purpose strings, the Android microphone foreground service. The committed plist carries `audio` since the flip and `ios.yml`'s pre-release patch is deleted. `callsCompiled.test.ts` asserts its switches agree with it ([below](#the-switches-agree-and-a-silent-frame-stays-unread)) |
| `CALLS_NATIVE_RING_COMPILED` | `true` | the NATIVE RING of an app closed or in the background (since 2026-10-21, B2'): `voip`, `USE_FULL_SCREEN_INTENT`, the Kotlin `CALLS_ENABLED`, the ObjC `kCanariCallsEnabled`. The first production calls (2026-10-22) shipped WITHOUT it; ON since 2026-10-30 for 1.5.2 ([the native ring ships](#the-native-ring-ships-in-152-owner-2026-10-30)), K6/K7/K8 owed, never on while `CALLS_COMPILED` is off (asserted) |
| `CALLS_ENABLED` | `CALLS_COMPILED \|\| deployEnvironment() === 'development'` | the in-app call buttons, `startCall`, `handleCallSignal`, the sibling check |
| `CALLS_VIDEO_ENABLED` | `CALLS_ENABLED` (since 1.5.2, owner 2026-10-30; `deployEnvironment() === 'development'` from 2026-10-21 to 1.5.1, `CALLS_ENABLED` from 2026-10-20) | the video-call button and the camera controls; in production behind `calls_mode = audio_video` ([turning video on](#turning-video-on-in-production---11-video-in-152-owner-2026-10-30), [video](#video-lot-2-2026-10-20---vp8-behind-a-clear-header-held-by-every-transceiver)) |

`VITE_DEPLOY_ENVIRONMENT=development` is written by `build.yml` for the dev web estate and by
`android.yml` / `ios.yml` for every pre-release - and those pipelines refuse a pre-release whose
backend is not `dev.canari-emse.fr`. A production build never sets it. So: **dev web + alpha apps
call; production web and stable apps do not.** A local workstation build sets nothing either; set
`VITE_DEPLOY_ENVIRONMENT=development` in `frontend/.env` to call locally (it also raises the banner).

**The flow.** Ring and hangup are unchanged (MLS `call_invite` / `call_answered` / `call_hangup`,
silent, over the chat socket - so an OPEN app rings; a killed one does not, that is `CALLS_NATIVE_RING_COMPILED`).
Then, on each side:

0. `POST /api/calls/initiate` binds the new room id to its group in Redis (`call:room:<id>`, TTL =
   ring window + 4 h call horizon) and returns `ringTimeoutMs`, THE ring window
   (`CALL_RING_TIMEOUT_SEC = 60`, chat-delivery `calls.service.ts`, the single source). The caller
   relays it in the invite (`CallMsg.ring_timeout_ms`, a duration, so no device compares clocks).
   `GET /calls/room-token` refuses a room bound to another group (403), an unknown or expired one
   (410) and a request outside the window (410) - the deadline is enforced there, on one clock.
   **The window OPENS at the caller's `POST /calls/ring`** (G1, 2026-10-17), sent and awaited
   BEFORE the invite: no callee can learn of the call before the server would issue it a token, so
   an early answer (a quick tap, an auto-accept) can never meet a 410 whose hangup would end a sound
   call. Nothing the caller does first (ICE servers, a first-time microphone prompt, key
   derivation, the join) eats into the callee's 60 s. Only the room's caller may open it, once: the
   deadline is its own key, `call:room:<id>:answer_by`, written with ONE `SET NX` that expires with
   the binding (never restarting its TTL), so concurrent rings cannot both open it. A refused ring
   rings nobody (the server opens the window before it fans out): no invite, no missed call, and the
   caller reads `call_setup_failed`. A call hung up while its ring was in flight is not invited,
   armed or published, and a second ring-end follows the completed fan-out. What is left: the
   server's clock starts a little BEFORE the callee's timer (armed on the invite's arrival), by the
   invite's delivery time - an answer in that last stretch is told `call_over` ("this call is
   over", a 410 from `room-token` mapped by `describeCallFailure` on the typed step), never a
   failure. A binding written by the lot 1 build (no `callerId`) is refused as expired, with a
   warning: a one-deploy gap, dev only.
1. `GET /api/calls/ice-servers` BEFORE ringing (caller) or joining (callee): a server without TURN
   credentials answers 503 and the call fails there, not after the callee has answered. A call that
   fails before its invite (initiate refused, no ICE servers, no microphone) writes NO missed-call
   message: nobody was rung.
2. `wss://<origin>/api/call` -> `{ type: 'Join', room_id, room_token, mode: 'p2p' }` -> `Joined`.
3. When both are in the room the relay sends `PeerReady { initiator }`: the caller (first in) is the
   initiator and offers; the callee is the POLITE side of perfect negotiation and never opens - it
   answers. `negotiationneeded` drives every offer, so a later camera-on renegotiates the same way.
4. `Offer` / `Answer` / `IceCandidate` cross the relay verbatim. `iceTransportPolicy: 'all'`
   (`CALL_ICE_TRANSPORT_POLICY`): host, then server-reflexive, then the Cloudflare relay. The trade:
   each party can learn the other's public IP.
5. On `connected` the client logs `[Call] selected path pair=<local>/<proto>-><remote>/<proto>
   relayed=yes|no [relay_proto=] [rtt_ms=]` (`utils/callStats.ts`, no address) - the client's own
   reading of its path, a DIAGNOSTIC. The TURN budget never reads it: it reads what Cloudflare
   metered ([the kill switch and the metered budget](#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21)).
   From then on a `[CALL_REPORT]` line every 10 s and one at the end carries the same pair plus
   rates, loss, audio levels and the E2E worker's frame counts
   ([calls-revival-plan section 6](calls-revival-plan.md#6-observability---a-call-report-that-carries-evidence)).
6. `PeerLeft` (the other party hung up, its away seat expired, or this device was replaced by a
   sibling) ends the call; a second `PeerReady` (the other party's device was replaced) rebuilds the
   peer connection, while `PeerReady { resumed: true }` keeps it - see
   [a network blip](#a-network-blip-does-not-end-the-call-call-wifi-2026-10-19).
7. **The ring window.** Both sides arm a timer of `ringTimeoutMs`. The caller's, if no `PeerReady`
   came, ends the call as MISSED (hangup + ring-end `cancelled` + the missed-call line). The callee's
   only covers a caller that vanished silently: the ring stops and nothing is written. A timer is a
   timer here by nature; what is DETERMINISTIC is that both read the server's one value, and that a
   late answer is refused by the server's own deadline, whatever either timer did. An invite with no
   window (an older dev build) does not ring and is logged.

Calls are offered in **direct** conversations only: the room seats two users, a third is `Refused
{ reason: 'room-full' }`, and a valid token for the same room id signed for ANOTHER group is
`Refused { reason: 'group-mismatch' }` before it is seated, so it never sees a candidate. Groups wait
for the group design (WP-C4/WP-C11).

**E2E is mandatory, never degraded.** No `RTCRtpScriptTransform` -> `CallE2eUnsupportedError`
before any request, with its own toast (`call_e2e_unsupported`). The legacy `createEncodedStreams`
path, the `encodedInsertableStreams` flag, `VITE_CALL_E2E_ENCRYPTION` and the "not encrypted" badge
are gone. **`android.yml` and `ios.yml` used to bake `VITE_CALL_E2E_ENCRYPTION=false` into EVERY app
build**, so an alpha app would have sent cleartext to a web peer that decrypts - removed. A transform
that fails to attach ends the call.

**Measured in Chrome 155 (2026-10-17), and it changed the code:** a RECEIVER transform attached in
`ontrack` to a receiver that was ALREADY running never saw a frame - the call connects, packets
arrive, every sample is concealed silence. Attached to the receiver of the transceiver `addTrack`
created, before negotiation, every frame decrypts. (Narrowed 2026-10-19: attached in `ontrack` for
a transceiver a RENEGOTIATION created, it decrypts every frame - [measured below](#audio-quality-measured-2026-10-19).) `initPeerConnection` now does that; `ontrack` attaching late logs a WARN. The same
session found the worker counting a failed decrypt as `decryptOk` (fixed: `decryptError` only).

**Server half:** [call-service p2p mode](../../services/call-service.md#peer-to-peer-mode-2026-10-17).

**What was verified, and how** (no device, no local estate):

| Claim | Evidence |
|---|---|
| The relay pairs, assigns roles, forwards verbatim, refuses a third user, a token for another group and a mode mismatch, announces a leave and a sibling replacement, and closes a socket on a frame over 64 KiB | `apps/call-service/tests/p2p_signalling.rs` (the real binary over real WebSockets) + `src/p2p.rs` unit tests (incl. the relay never waiting on a full partner queue) |
| A room is bound to its group; a token for it is refused for another group, an unknown room and after the ring window | `apps/chat-delivery-service/src/services/calls.service.spec.ts` |
| The client speaks that protocol (Join p2p, roles, offers only as initiator, answers as polite, refuses without the transform, rebuilds on replacement), honours the ring window on both sides, and writes no missed call for a call that never rang | `CallService.p2p.test.ts` (fakes of WebSocket, RTCPeerConnection, worker) |
| Two Chrome 155 contexts connect DIRECT (`host/udp->host/udp`) through the real relay, the REAL `encryption.worker.ts` encrypts and decrypts Opus, and the callee hears the caller's 440 Hz tone (RMS 0.71, peak 445 Hz) | a scratch page mirroring `CallService`'s negotiation, by hand, chrome-devtools MCP; a wrong key yields only `decryptError` and no decoded sample |
| The signalling socket survives an idle call | the same run: one socket held 3.6 h with only the keepalive pings, then every 25 s - every 10 s, and answered, since 2026-10-19 (local, no proxy in front) |

**NOT verified - owed:** the real app end to end (no local estate was up); a TURN-relayed call
(read since, forced from outside the app on desktops and both phones, 2026-10-20 - see the TURN
paragraph below);
anything on the Mi 9T or the iPhone (Android System WebView's and
WKWebView's `RTCRtpScriptTransform`, the late-receiver behaviour on WebKit, microphone permission in
the Tauri WebViews, audio routing); cellular and campus networks; the host nginx's 60 s timeout and
the Cloudflare tunnel in front of dev (the keepalive is there for them, unmeasured through them).

**The dev TURN secrets EXIST since 2026-10-17** (`DEV_CLOUDFLARE_CALLS_API_TOKEN`,
`DEV_CLOUDFLARE_TURN_KEY_ID`, GitHub secrets). `serve-dev.yml` and `env-manifest.tsv` read them, and
`docker-compose.dev.yml` hands them to chat-delivery-service since lot 1 (it did not before - the
secrets alone would have changed nothing). **They have reached dev since `v1.3.0-alpha.2`**: the
`v1.3.0-alpha.4` dev deploy (2026-10-19) passed both and raised no "not set" warning for them, and
dev serves lot 1, the ring window (#2010) and the call permission (#2048). Unset, dev would answer
503 on `/api/calls/ice-servers` and every call would fail at step 1 - by design, not a fallback to
STUN only. The phone procedure is
[check CALL-L1](../../device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both).

**The TURN budget estimator is gone (B7, 2026-10-21):** it counted EVERY call as relayed at
3000 kbps; the budget now reads Cloudflare's own meter
([below](#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21)). (A conversation at
`none` ringing an OPEN app was closed on 2026-10-18 by the call permission below.)

## The server's kill switch and the metered TURN budget (B12, B7, 2026-10-21)

Two server-side controls the owner asked for before calls reach production (2026-10-21: a server
kill switch, YES; the TURN budget fixed before its production value is touched). Neither flips
anything: production's switch defaults to `off`, and `CALLS_COMPILED` is untouched.

### The kill switch - `platform_config.calls_mode`

| Value | What the server allows |
|---|---|
| `off` (the default, migration 014) | nothing starts: `initiate`, `ring`, `room-token` and `ice-servers` answer 403 `CALLS_DISABLED` |
| `audio` | every call, except a ring that asks for video: 403 `CALLS_VIDEO_DISABLED` - see the limit below |
| `audio_video` | everything |

- **Where it lives.** One column on core-service's singleton row (`014_platform_config_calls_mode.sql`,
  a CHECK constraint holds the three values), set by a global admin at `/admin/platform` through the
  existing `PATCH /api/users/admin/platform` (`callsMode`). A change is logged at `warn` with its
  actor (`callsMode off -> audio by=<first 8 of the admin's id>`, from `x-user-id` like the
  announcement routes). The page sends ONLY the fields changed since it loaded (or since its last
  save's answer): a form left open while another admin closed calls used to PATCH every field back
  as loaded and silently re-open them. With no snapshot (the load failed) the save is REFUSED
  (`admin_platform_save_needs_load`): sent whole, it would write the form's placeholders, calls
  `off` and a floor of `0.0.0`, over the server. The three values are spelled in five places (the CHECK,
  core's entity, chat-delivery's reader, `utils/appVersion.ts` `CALLS_MODES`, the admin page through
  it), and `utils/callsModesAgree.test.ts` fails the day one drifts. The plan's `testers` value was not built: pre-release builds talk to
  the dev estate, whose OWN row is its own switch.
- **Who enforces it.** chat-delivery-service reads the row with plain SQL on EVERY call request that
  starts or joins a call (`utils/calls-mode.ts`, `CallsService.assertCallsOpen`), never cached, so a
  kill holds from the next request. A missing row reads as `off` AND logs at error (`platform_config row 1 is MISSING`), so a
  lost row is not mistaken for an admin's `off`; a value outside the three THROWS
  (a switch that cannot be read is not read as open). `ring-end` and `presence` are never gated: they
  stop or record a call.
- **How far `audio` is enforced.** On the server, ONLY by the ring's DECLARED `hasVideo`: `ring`
  refuses a ring that says it carries video. `initiate`, `room-token` and `ice-servers` take no
  media kind and check only `off`, so a callee joining an audio call, or a client that declares
  audio and then sends video, is not refused by anything server-side. The client hides the video
  button and the camera-on control; the server cannot see the media, which is peer to peer.
- **What it cannot do.** A call already connected is peer to peer and never touches the server
  again: it runs to its end. The switch stops every new call, every callee still to answer, and
  every new TURN credential. A modified client could still turn its camera on inside an `audio`
  call (renegotiation goes through the relay, which reads no mode); it costs the server nothing, and
  relayed bytes are on the meter below.
- **What the client does.** `GET /api/version` publishes `calls: { mode }`; `serverCallsMode()`
  (`stores/appVersionCheck.svelte.ts`) reads it, `off` until an answer came - absent or unknown
  reads as `off`, the closed direction. `utils/callsAvailability.ts` joins it to the build switches:
  the audio button needs `CALLS_ENABLED` and a mode other than `off`; the video button and the
  in-call camera control need `CALLS_VIDEO_ENABLED` and `audio_video` - to turn the camera ON: the
  control stays while the camera runs, so a mode dropped to `audio` mid-call never leaves a camera
  nothing on screen can stop. **Three more readers act on it once an answer exists** (`callsAvailableAnswered()`: when no answer came yet it awaits `refreshAppVersionCheck`, so an invite that beats `/api/version` is judged on the answer, never on the default `off`): the incoming-invite gate in `CallService.handleCallSignal` (an ANSWERED `off` does not ring, logged), `handleCallSignalForChat` (the same predicate writes a MISSED call instead of "call started"), and the session-start `/api/calls/sibling-status` check. The per-conversation 'calls allowed' control in `ChatGroupPanel` uses `callsAvailable(serverCallsMode())` and is simply hidden while off. The session cache of `/api/version` stores the WIRE shape
  (`serverVersionInfoToWire`), the one it parses back; it stored the parsed shape and read every
  cached mode back as `off`. A refusal at any setup step
  carries its code (`CallInitiateError`, now also for `ring` and `ice-servers`) and
  `describeCallFailure` words it (`call_calls_disabled`, `call_video_disabled`) - the call ends as a
  refused setup, with no missed-call line when it failed before the invite.
- **Dev** seeds `audio_video` (`tools/dev-seed/seed.ts`). An EXISTING dev database gets the
  migration's `off` and must be opened once at `/admin/platform` after the deploy that carries
  migration 014 ([backlog](../../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)).

### The TURN budget reads Cloudflare's meter (B7)

**What was wrong.** `getIceServers` refused credentials once a Redis counter reached
`CLOUDFLARE_TURN_MONTHLY_BUDGET_GB` (950), and the counter was an ESTIMATE: call duration x
`CALL_RELAY_KBPS_PER_DEVICE` (3000), added when a device cleared its presence. Every call counted
as relayed, at a video rate - in P2P only a call whose selected pair is a relay candidate costs, and
an audio call is tens of kbps. 950 GB read as ~350 call-hours a month, after which every call of
the month would have been refused.

**Why not the client's path.** Counting `relayed=yes` calls from the client's final path (B6) is a
claim the server cannot verify, and CALL-PATH-LINE showed the client's line can be wrong without
any malice; a client that lies under-counts with no bound.

**The budget itself** (`readTurnBudget`, `CLOUDFLARE_TURN_MONTHLY_BUDGET_GB`, an optional GitHub
secret on each estate, `silent` in `env-manifest.tsv`): UNSET or empty is the default, 950 GB. An
explicit `0` is the owner's decision of 2026-10-21 - **calls stay open but are STUN only, never
relayed**: `ice-servers` answers STUN only with its own code, `TURN_DISABLED` - never
`TURN_BUDGET_REACHED`, which would read as a spent month - without asking the meter, and BEFORE the
TURN secrets are checked, so an estate at 0 needs none and never answers 503. Logged per call at
`log` (a decision, not a fault); the client logs it at info and a call that cannot connect says
`call_relay_disabled` ("this server does not use a call relay"), not the "unavailable right now" of
an outage. Anything but a whole number (digits AND a safe integer: 400 digits are refused) is read
as 0 with the same code, the closed direction, and logged at ERROR per call and per report - and
`render-env.sh` refuses to deploy it at all (`whole_number`). What 0 cannot do: credentials issued
before the switch keep relaying until `CLOUDFLARE_TURN_TTL_SECONDS` (2 h) runs out. Dev and
production are ONE Cloudflare account and one free allowance; each estate's budget is its own value
(`DEV_CLOUDFLARE_TURN_MONTHLY_BUDGET_GB` on dev), and the meter each reads is the account's. It used to answer 950 for every value that was not a positive integer, `0`
included, so "never relay" could not be written at all.

**What it reads instead** (`services/turn-usage-meter.service.ts`): Cloudflare's GraphQL analytics,
dataset `callsTurnUsageAdaptiveGroups`, `sum { egressBytes }` for the WHOLE ACCOUNT from the first of
the UTC month to today. **The budget's period is the UTC CALENDAR month**, which is not guaranteed
to be Cloudflare's billing cycle: the cap is ours, and a cycle that straddles two calendar months
can see up to two budgets' worth. Egress is what Cloudflare bills and its free allowance is per account, so
another key on the account spends the same allowance. Direct calls put nothing on the meter by
construction; no client says anything. Configuration: `CLOUDFLARE_ACCOUNT_ID` (32 hex) and
`CLOUDFLARE_TURN_ANALYTICS_TOKEN` (a token with Account Analytics read), `env-manifest.tsv` `warn`
on both estates. One reading is reused for 60 s (`turn:metered:<YYYY-MM>`): a member hammering
`ice-servers` must not spend the GraphQL quota, and concurrent setups share ONE meter reading in
flight (single flight). The TURN CREDENTIALS are never shared: one request to Cloudflare per
`ice-servers`, since a credential is a member's for its TTL. Every request to Cloudflare - the meter's and the credentials' - carries
`AbortSignal.timeout(5000)`: past it the meter is unavailable (typed) and the credentials call a
logged 503, so a Cloudflare that never answers cannot hold call setups open.

**The query, and the documents it is read from.** The filter is `date_geq` / `date_leq` (whole UTC
days, `YYYY-MM-DD`), not `datetimeMinute`: the month is whole days and the dataset's own example
filters on `date` ([TURN analytics](https://developers.cloudflare.com/realtime/turn/analytics/)).
The window a query may span is NOT assumed: the meter first asks
`settings { callsTurnUsageAdaptiveGroups { enabled maxDuration notOlderThan } }`
([settings node](https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/)),
cached an hour (`turn:metered:settings`, logged when read), and `dateChunks` splits the days it
must ask into whole-day ranges no wider than `maxDuration`, asked as aliased sub-queries (`c0`,
`c1`, ...) in ONE request, each grouped by `dimensions { date }`.

**Every readable day is re-asked; only days past retention come from storage.** Each reading asks
Cloudflare for EVERY day of the month still inside `notOlderThan`, and writes what it got to the
Redis hash `turn:metered:days:<YYYY-MM>`, overwriting: nothing is frozen while Cloudflare can still
correct it (a late ingestion, a session booked at a day's close - a first version froze a day an
hour after it ended, and would have under-counted those for the rest of the month). Only a day
Cloudflare RETURNED a group for is stored; a day with no group is never stored as 0, and a field
`covered_from` records how far back readings reached. A day that has LEFT the retention is summed
from its stored total, or counted as no relay if it was covered and had no group, and a day never
read at all makes the meter unavailable. The hourly report below re-reads the meter while calls are
open, so a day is read until its last readable hour. A `maxDuration` under a day is refused too -
an under-count is a budget that never trips.

**A meter that cannot be read withholds TURN, never the call** - a typed degradation, not a
fallback. Unconfigured, unreachable, an HTTP or GraphQL error, no visible account, a dataset not
enabled, a non-number: `ice-servers` answers 200 with STUN only (`stun:stun.cloudflare.com:3478`) and
`turn: { status: 'unavailable', code: 'TURN_METER_UNAVAILABLE' }`; a spent budget answers the same
with `TURN_BUDGET_REACHED`. Both log at ERROR (`[ICE] call=<id> TURN withheld (<CODE>)`), and the
client logs `[Call] ERROR: TURN relay withheld by the server (<CODE>) - direct path only`. WHY THIS
SHAPE: a 503 failed EVERY call, including the ones between two reachable peers that cost nothing,
because a third-party analytics API had a bad minute; minting credentials without a reading would
spend the money the budget exists to cap. STUN only does neither, and a call it cannot connect (both
peers behind NAT) fails at ICE with the error line above explaining it, and the toast says it in
its own sentence (`CallRelayWithheldError` -> `call_relay_withheld`), not "connection lost". A failure is remembered 30 s
(`turn:metered:unavailable`): an outage costs one API call and one error line per 30 s, not one per
call setup. TURN NOT CONFIGURED AT ALL (`CLOUDFLARE_CALLS_API_TOKEN` / key id unset) is still a 503:
that is a deployment defect, not a transient reading.

**The meter has a report** (`CallsService.reportTurnMeter`, hourly and once a minute after boot, in
the service's family of hourly reports): `[TURN-METER] <YYYY-MM> (UTC calendar month): x/y GB
metered egress (z%)` at `log`, at ERROR when the budget is reached or the meter is unavailable while
calls are open, and NOTHING while `calls_mode` is `off` (nobody's concern then, so an hourly error
would be noise). WHY A REPORT AND NOT A FAILED DEPLOY: a missing token is one case of three - a
revoked or mis-scoped token is invisible to a deploy, and a `required` key would block every
production deploy while calls are off there. The report sees all three, once an hour, while it
matters.

The limits, named: credentials already issued stay valid for `CLOUDFLARE_TURN_TTL_SECONDS` (2 h), so
the overshoot past the budget is what the credentials outstanding at that moment relay, plus the
meter's lag (minutes).

**Measured against the live API (2026-10-21, the production token):** the endpoint is
`https://api.cloudflare.com/client/v4/graphql` (the bare `/graphql` answers 10404 "No route"), and
the `settings` query answers `enabled=true`, `maxDuration=2764800`, `notOlderThan=2764800` (32 days).
So a whole calendar month (31 days at most) is one chunk and never leaves the retention: on this
account every reading asks the whole month, and the stored totals are never used. **Still unexercised:** the
per-date usage query itself (`dimensions { date }`, `orderBy: [date_ASC]`); the first dev deploy
carrying this answers it, and a refusal names itself in the `[ICE]` error line.

## A network blip does not end the call (CALL-WIFI, 2026-10-19)

**Measured** on the bench ([readings](../../device-readings-2026-10.md)): a 6 s and a 14 s Wi-Fi
outage on the Mi 9T each ended a connected call on the FIRST signalling close -
`[Call] terminal failure: signalling WebSocket closed code=1006 - ending call` - with no reconnect
and no ICE restart. A transport failure is not an answer, so it no longer ends anything.

**The design** - every end is an answer or a spent budget, never a clock:

| Event | Client (`CallService.ts`) | Server ([call-service](../../services/call-service.md#peer-to-peer-mode-2026-10-17)) |
|---|---|---|
| this device's signalling socket drops after `Joined` | `onSignallingLost`: re-open on the shared ladder CAPPED at 4 s (`cappedReconnectDelayMs` in `utils/reconnectBackoff.ts`: 1, 2, 4, 4, 4... s), `Join` with the seat's `resume_token`; each attempt has ONE deadline for open AND `Joined` (`CALL_SIGNALLING_RESUME_TIMEOUT_MS`, 5 s - a resource bound: a socket stuck CONNECTING on a black-holed network costs one attempt, not the ladder) | the seat stays ABSENT for `CALL_P2P_SEAT_GRACE_SEC` (60 s) from when the server HOLDS the socket dead - a write error, or two keepalive pings unanswered (`keepalive-lost`, at most 30 s); the partner gets `PeerAway` |
| resume joined | `signalling resumed on attempt N`; the next `Joined` brings a fresh token | the seat is taken back IN PLACE (same roles); both get `PeerReady { resumed: true }` |
| `PeerReady { resumed: true }` | keep the peer connection; `restartIfMediaDidNotSurvive` reads EVIDENCE: either state machine down, no inbound audio packet since the break (`getStats`), or - on the initiator - an offer still pending (its answer died with a socket). Any of them -> the initiator sends an explicit restart offer, the polite side a request | - |
| ICE `disconnected` (first restart of a loss), or ICE OR `connectionState` `failed`, after it had connected, signalling up | initiator: `createOffer({ iceRestart: true })`, sent at once, after rolling back any pending offer; the POLITE side sends `IceRestartRequest` (it cannot offer), on its OWN 3-per-loss budget, and the initiator restarts even if its own path looks connected. ONE offer (or request) per pairing is in flight: its answer comes over a live relay, or the pair breaks and a new pairing starts | relays `IceRestartRequest` verbatim |
| `PeerAway` | the call goes on, `reconnecting = true`; a new pairing (an offer sent before is never waited on again); ICE restart deferred until `PeerReady { resumed }` | - |
| **ends the call** | `PeerLeft`; a resume `Refused` (`call-over`: seat expired or partner hung up); the MLS `call_hangup`; **15 resume attempts** (`CALL_SIGNALLING_RESUME_ATTEMPTS`, the last starting at +55 s) or **3 ICE restarts or restart requests** since the path last connected (`CALL_ICE_RESTART_ATTEMPTS`) spent | Close frame = hangup -> `PeerLeft` at once; grace spent -> `PeerLeft` |
| ICE `failed` on a path that NEVER connected | ends the call, as before: there is nothing to restore | - |

A relay without the resume protocol (no `resume_token` in `Joined`) still ends the call on a drop,
saying so: `... and the relay gave no resume token`.

**The two clocks are not one.** On a network that refuses at once, the 15th attempt starts 55 s
after the CLIENT's loss; the seat grace is 60 s from when the SERVER holds the socket dead (up to
30 s later). On a black-holed network each attempt runs its 5 s deadline, and a session refresh
before an attempt is not bounded here, so the server MAY give up first; the late resume is then
answered `call-over` and the call ends, the outcome the budget would have reached anyway. **The
partner of a device that never comes back ends at most ~90 s after the loss** (keepalive detection
<= 30 s, then the 60 s grace, then `PeerLeft`) - bounded by the server's answer, never by a client
timer, and its own socket dropping hands it to its own attempt budget.

### What the `1.3.1-alpha.2` bench reading found (2026-10-19), and the fix

[Readings](../../device-readings-2026-10.md): 6 s outage `PASS`; 14 s `FAIL` (resumed only at
attempt 5, +32 s, a restart request went out, then nothing - both phones on "Reconnexion..." with no
audio); 90 s `FAIL` (the Mi 9T ended itself at +30 s, the iPhone sat on "Reconnexion..." for 100+ s).
Read from the Mi 9T's exported log and the code, three causes, one chain:

1. **The server never saw the Mi 9T's socket die.** Wi-Fi off leaves a HALF-OPEN socket: the 25 s
   ping write landed in the kernel buffer and "succeeded", so no `PeerAway`, no grace, no `PeerLeft`
   - the 90 s ghost. **Fix (server):** the keepalive is 10 s and the peer must ANSWER it - two
   pings in a row with no frame of any kind back and the socket ends `keepalive-lost`, which keeps
   the seat for a resume like any network failure
   ([call-service](../../services/call-service.md#peer-to-peer-mode-2026-10-17)).
2. **The iPhone's restart offer went into that dead socket and was lost**, leaving its peer
   connection in `have-local-offer`. Every later `pc.restartIce()` then fired no
   `negotiationneeded` (it only does from `stable`), so nothing was ever offered again; and the Mi
   9T's `IceRestartRequest` after its resume was dropped because "a restart was in flight" - a
   restart of a pairing that no longer existed. **Fix (client):** the restart is an EXPLICIT
   `createOffer({ iceRestart: true })`, sent at once, after rolling back any pending offer; and an
   offer or request belongs to the PAIRING it was sent in (`pairEpoch`, bumped on every signalling
   break and every `PeerReady`), so one from an earlier pairing never blocks a new one.
   **Two invariants keep an answer with ITS offer** (review of #2148): every negotiation step -
   the relay's frames (all but `Joined` and `Refused`, which settle the socket itself and are
   handled at once), `negotiationneeded`, an ICE restart offer - runs on ONE queue
   (`signalQueue`), so no offer is rolled back or made while an answer is half applied; and every
   offer carries a NUMBER (`seq`, inside the `sdp` string the relay already forwards verbatim -
   `call-service` is unchanged) that the answerer echoes. An answer to any offer but the pending one
   is dropped, named. A client older than the numbering sends none, and its answers are matched by
   signaling state alone, as before (calls are dev-only, so both phones carry it after one deploy).
   An engine that cannot CREATE the restart offer ends the call with
   `ICE restart offer could not be made: <error>` - a retry would meet the same connection in the
   same state.
3. **The resume itself was late:** the uncapped ladder put attempt 5 at +31 s. **Fix:** capped at
   4 s, 15 attempts (the 14 s outage resumes at +15 s).

Also read in that log: Android Chromium reached `connectionState=failed` while
`iceConnectionState` stayed `disconnected`, so `connectionState=failed` now triggers the restart
too (`mediaPathDown` reads both). And the resume decides from the inbound audio packet count
across the outage, not from a state that may still read `connected` on a path carrying nothing.

**The restart budget counts per media LOSS, across pairings** (`CALL_ICE_RESTART_ATTEMPTS`). An
offer that went into a dead socket costs one restart - the price of a bound a flapping peer cannot
escape, since the keepalive can now break a pairing every 20-30 s. It is CHARGED when the offer is
actually made (`sendIceRestartOffer`, after its pairing check; the polite side's request when it is
sent), so a restart dropped in the queue costs nothing. It is REFUNDED on evidence, not only on a
state transition: when ICE connects, when a resume finds MORE packets after the outage than before
it (unreadable stats are no evidence, and refund nothing), or when
the inbound packet count at a new break is above the count taken when the last restart's
negotiation completed (`packetsAtRestart`) - a restart that worked while ICE never left `connected`
(review of #2148: otherwise a long call ended at its third blip). **Every queued step belongs to
the call it was queued for**: a step whose call is over (another call, idle, or the 1.5 s ended
summary) is dropped - SILENTLY when it is still that call's ended summary (an ordinary hangup
delivers both the MLS hangup and `PeerLeft`: expected), logged once per call
(`... dropped - the call is now ...`) when it met a different call or none - and `failCall`
on a call already over does nothing - so a late `PeerLeft` or restart can never end the next call
or print a second "terminal failure". Two edges are recorded, not built (F6, F7 in
[backlog](../../backlog.md)). The resume ladder has no jitter: two clients that lost the same
network at the same moment retry in step (P3 in [backlog](../../backlog.md)).

**A BEHAVIOUR CHANGE: A SUSPENDED APP NOW LEAVES THE CALL.** The keepalive's Pong comes from a
RUNNING process. An iOS or Android app the OS froze mid-call (screen locked, sent to the
background) answers nothing, so it is held dead 20-30 s in and its partner gets `PeerLeft` ~60 s
later; before, its half-open socket kept the seat "present" indefinitely. Whether the bench phones
stay running in a call is owed: CALL-L1 row 11.

**AN ACCEPTED COST: AN APP KILLED BY THE OS NOW LOOKS LIKE A BLIP.** A killed app sends no Close
frame and no MLS hangup, so the server cannot tell it from a network loss: the partner sees
"Reconnexion..." for the 60 s grace, then `PeerLeft`, where it used to get `PeerLeft` at once. A
deliberate hangup (the button, a page closed by the user - the browser sends a Close frame) still
ends the call immediately.

**THE UI CONTRACT: `callService.reconnecting` (a `Writable<boolean>`), shown with
`m.call_reconnecting()` ("Reconnexion..." / "Reconnecting...").** `true` while a call in `incall`
that had connected is getting its connection back: this device's signalling is resuming, the other
party's is (`PeerAway`), or ICE is not `connected`/`completed` after having been. `false` outside a
call, while ringing or connecting (that is `calling`), and as soon as the ended summary shows. Every
change is logged with its three facts: `[Call] reconnecting=<bool> (signalling=lost|up
peer=away|present ice=<state>)`. **No component reads it in this change (#2137)**: the screen shows
"Reconnexion..." once the call UI of #2138, stacked on it, subscribes to it. Until then the call
survives the blip with nothing on screen saying so.

**Pinned by** `CallService.p2p.test.ts` ("a network blip does not end the call": fake socket, fake
peer connection with rollback and inbound packet stats, fake `setTimeout` stepped through the
ladder, no real sleep - including "the bench outages of 2026-10-19, replayed": 6 s, 14 s on each
phone, 90 s on each phone) and `apps/call-service` (`src/p2p.rs` seat tests,
`tests/p2p_signalling.rs` drop / resume / Close / grace-0 expiry / stolen token / a silent
half-open peer held dead by the keepalive, and its resume, over the real binary). **What the
fakes cannot prove:** the ORDER in which a real engine completes a rollback, an offer and a
remote answer. The async fake (`latency`) reproduces ONE interleaving class - an operation started
beside another overlapping it - and a mutation check shows it catches both a step run beside the
queue and a missing offer-number check; WebKit's and Chromium's real ordering is read only on a
phone. **Owed on a phone:** check CALL-L1 row 0 first (an idle call proves the Pong crosses the
tunnel and nginx), then steps 8-11
([device-verification](../../device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both)).
Not handled here: a phone that changes network WITHOUT its socket dropping relies on ICE alone
(`disconnected` -> one restart); cellular handover is unmeasured (no SIM on the bench).

## The user's decisions of 2026-10-18

Four points of the revival, decided by the user. Each holds for every platform and is not to be
re-opened.

| # | Decision | Where it lands |
|---|---|---|
| (6) | **The caller's name on a silent ring comes from the PHONE'S LOCAL copy** - the same mechanism as the mention-name package (the device's own store of the people it shares conversations with), **never from the notification payload**. A caller the phone does not know shows the neutral "Canari call". | WP-C5 (Android) and WP-C6 (iOS). The ring push today still carries `callerName` / `senderName` / `groupName` (`CallsService.ringGroup`); they leave the payload when the native ring is rebuilt, never restored as a fix for an untitled banner (the SIXTH item above) |
| (ICE) | **`iceTransportPolicy` stays `'all'`**: direct first, Cloudflare TURN as the fallback. The trade (each party can learn the other's public IP) is accepted and owed to the privacy policy (F4 above). | `CALL_ICE_TRANSPORT_POLICY` in `CallService.ts` - unchanged |
| (block) | **No call crosses a block, in either direction, also inside a conversation that already exists**: `403 USER_BLOCKED`, a neutral message, never who blocked whom. | BUILT 2026-10-18 (WP-C7): `initiate`, `ring` and `room-token` refuse, and the client does not ring an invite across a block - [below](#the-switches-agree-and-a-silent-frame-stays-unread) |
| (7) | **Calls get their OWN per-conversation permission**, independent of the notification level (the user, asked whether a ring obeys a conversation at `none`: *"Could we add a 4th profile to allow or not calls?"*). | the section below |

## The call permission - its own setting per conversation (decided 2026-10-18)

**What it is.** Beside the three notification levels (`all` / `mentions` / `none`) a private
conversation carries a second, independent setting for this account: **calls allowed** or **calls
not allowed**. Whether a conversation may RING is a different question from how loud its MESSAGES
are, so it is not a fourth level: a member can keep a busy group at `mentions` and still take its
calls, or keep a DM at `all` and refuse to be rung by it.

**The default, and why.** Stored as `dm_group_members.callsAllowed` (migration 032), `BOOLEAN NULL`.
NULL means "never chose", and it resolves against the level: **calls ring unless the conversation is
at `none`.** An explicit true/false overrides the level both ways. Why this default is the least
surprising one:

- **A member who set a conversation to `none` asked it to be silent.** A phone ringing in full screen
  for that conversation is the loudest thing the app can do; nothing in "Aucune" says "except calls".
  It is also what such a member was already getting: at `none` the invite frame is sent silent.
- **Everybody else keeps what they expect from a messenger**: a DM at `all` or `mentions` rings.
- **NULL rather than a stored `true`** keeps the default MOVING with the level: a member who never
  chose and later mutes the conversation stops being rung, and unmuting rings again. A stored value
  would freeze whatever the level was the day the column appeared.
- **Old clients are safe by construction**: they never send or read the field, the column stays NULL
  for every row they touch, and NULL is the rule above - never "rings where the member refused".

The rule is ONE function on each side - `callsAllowedFor` in
`apps/chat-delivery-service/src/entities/group-member.entity.ts` and in
`frontend/src/lib/notifications/callPermission.ts` - each pinned by its own test
(`notification-preferences.controller.spec.ts`, `notificationPreferences.test.ts`).

**Where it is enforced.**

| Path | Who applies it | What a refused conversation gets |
|---|---|---|
| The ring PUSH (`POST /api/calls/ring`: FCM `call_ring`, APNs VoIP) - the only thing that rings a killed or backgrounded phone | **the server**, `CallsService.ringGroup` -> `membersWhoTakeCalls`, read at each ring, never cached | no push at all, whatever build the phone runs; logged `[ring] call=... withheld from N member(s) - calls not allowed in this conversation` (ids cut). The caller is told nothing - the call goes unanswered like any other |
| The in-app invite (MLS `call_invite` over the chat socket - ciphertext the server cannot read) | **the client**, from its copy in `notificationPreferences` | `CallService.handleCallSignal` does not ring (logged); `handleCallSignalForChat` writes the call as **MISSED at once** (`recordCallEnded` with outcome `not-answered`, final - the caller's later hangup leaves it), so the line is in the conversation instead of the ring. One predicate, one timeline writer |
| A native handler that decrypts a `call_invite` push (Android `CanariFirebaseMessagingService`, iOS `canari_push.mm` and the notification extension) | **never rings** (2026-10-30): the native ring is the server's `call_ring` alone, the one ring that passed `calls_mode`, the conversation's permission, the video rule and blocks. A decrypted invite is logged and dropped; `incomingCallScreen.test.ts` fails if either branch rings again | - |

**Stored and synced like the level.** On the member's own membership row: per ACCOUNT, every device,
survives a reinstall, ends with the membership (leaving and account erasure hard-delete the row -
`GroupMember.userId` is `delete` in `account-erasure-coverage.ts`, so the new column needs no entry
of its own). Written by `PATCH /api/mls/groups/:groupId/calls` `{ allowed: boolean }` (403 for a
non-member, 400 for a non-boolean); read in the same `GET /api/mls/notification-preferences` the
client makes at sign-in, as `groupCalls` (explicit choices only - an absent group never chose). It
refreshes on the same three occasions as the level
([chat-delivery](../../services/chat-delivery.md#a-conversations-notification-level---the-server-applies-none-the-device-decides-mentions)),
and the server reads the column at each ring, so a stale client copy can only mis-draw the in-app
ring of an OPEN session, never a push. **Named case: a cold start.** An invite replayed before the
first `load()` answers (or after it failed) finds no preference, so every conversation reads as
`all`: it rings in-app, and is written as `started` rather than missed, even where the member
refused. Holding the decision needs a counted wait on the replay path and a rule for a `load()`
that never answers, so it is left; the push is unaffected. **The endpoint's body is constant
(`{ ok: true }`) and the fan-out runs after the answer**, so neither the body nor the response time
tells the caller whether a callee refused (the count stays in the server log). `PATCH .../calls`
accepts a group conversation id too, though the control is drawn only in a direct one - WP-C11
(group calls) must decide what a group-wide refusal means before it draws the control there.
Like the level, it is a member's own setting on their
membership row, not a new processing purpose, so the register of processing is unchanged.

**The control.** `CallPermissionControl.svelte` (two radios, Paraglide `chat_calls_permission_*`, fr
+ en), drawn under the notification level in `ChatGroupPanel` - **only in a direct conversation of a
build with calls on** (`CALLS_ENABLED`), the only place a call can be placed today. Nothing is
checked until the store has answered, the rule `NotificationLevelControl` follows.

**Verified:** unit and component tests (server: the fan-out withholds a refused member and asks for
no token when nobody may be rung; the controller's read and write; the rule. Client: the store, the
missed line, the invite not ringing, the control). **Not verified on any device. Owed, on dev:** a
DM set to "not allowed" on one side - the other side's call goes unanswered, the open app does not
ring and shows the missed-call line, the server logs `withheld from 1 member(s)`; set back to
"allowed", it rings; a DM at `none` with no choice made does not ring; the control read once on the
Mi 9T and on the iPhone.

**WHAT THE REVIEW OF #1997 SAID WAS OWED BEFORE `CALLS_COMPILED` FLIPS** (2026-10-17). Built in
draft #2013 on 2026-10-18, PORTED onto `main` on 2026-10-21 (it predated #2158 and #2166, so it
was recreated, not rebased):

- **One key per direction, every frame bound to its kind** (`utils/callKeys.ts`,
  `utils/callFrameAad.ts`, `workers/encryption.worker.ts`). Each direction's key is
  `exportSecret(groupId, 'mls-webrtc-media-v2', '<callId>|<sender role>', 32)`; the role is
  `caller` on the device that rang (`startCall`) and `callee` on the one that answered
  (`acceptCall`), never the relay's `initiator`, which a resume or a replaced device can change.
  The caller sends with `caller` and decrypts with `callee`, the callee the reverse; the worker
  imports the send key for `encrypt` ONLY and the receive key for `decrypt` ONLY, and refuses a pair
  of EQUAL keys. Every frame's AES-GCM additional data is `canari-call-v2|<audio|video>` followed by
  the bytes it keeps in clear (none for audio, the VP8 payload header for video - the #2166 binding,
  kept). **The kind is handed to the worker by the page**, in each `RTCRtpScriptTransform`'s options
  (`{ side, kind, epoch }`, the track's own `kind`): the worker no longer reads it off the frame's
  class NAME, and a transform carrying no kind forwards nothing and says so. So: the two directions
  never share a `(key, nonce)` space; a reflected frame fails; an audio frame offered to the video
  receiver fails; another call's frames fail (the call id is in the export). Pinned by
  `encryption.worker.test.ts` (two KNOWN-ANSWER vectors computed with `node:crypto`, one audio, one
  VP8 interframe; reflection; wrong kind; equal keys) and `callKeys.test.ts`. **Not covered: replay
  WITHIN one direction and kind** - no sequence number is bound, so a frame replayed on the media
  path decrypts again; DTLS-SRTP's own replay window below the transform is what stands there.
- **F5 - a mismatch the user SEES.** Each receiver transform counts its decrypt FAILURES while it has
  decrypted nothing; at `DECRYPT_MISMATCH_FAILURES` (100, about two seconds of audio) the worker
  posts `undecryptable` once. A matching key opens the very first frame, so a working call never
  reaches the count: it is a proof, not a timer. The page (`CallService.onUndecryptable`) reads it
  against THIS peer connection's evidence: no receiver decrypted anything (`e2eReceiverSeen`) -> an
  `ERROR E2E key mismatch` line and the `call_e2e_key_mismatch` notice, once per call; another
  receiver decrypts -> the keys agree and this receiver is broken another way, an ERROR line and no
  notice; a stale epoch (a replaced device's dead peer connection) -> ignored. A replaced device is
  judged on its own frames. A key AGREEMENT over signalling is still not built (the relay carries a
  closed set of frames); two exported logs settle it: one side's `send_fp` must equal the other's
  `recv_fp`. The call is not ended by it: the user is told, and hangs up. **A setup never outlives
  its call** (review of #2176): a hangup during the microphone prompt used to let `startCall` resume
  after `cleanup`, key a worker whose memo outlived the call, and leave the NEXT call silent under
  the previous call's keys - which this notice would have blamed on the app's version. Every await
  of `startCall`/`acceptCall` is now followed by `assertSetupLive` (a sequence bumped at each setup
  and each cleanup): a late microphone is stopped, late keys are zeroed and never posted, and no
  socket or ring follows (`CallSetupAbandonedError`, no toast). The ended summary counts as over
  too: ICE connecting inside it no longer turns `ended` back into `incall` (which skipped `cleanup`
  and left the microphone open), the signalling socket checks the same sequence before it opens, and
  `cleanup` settles a pending worker-key wait so its 3 s timer never reaches the next call.
- **The key log is a hash**: `media keys derived from MLS (role= send_fp= recv_fp=, sha256)`, the
  first 4 bytes of each key's SHA-256 (`keyFingerprint`), never key bytes. A build older than
  2026-10-21 printed key bytes: never paste its `fp=` line.
- **F4 - who sees what**: row C21 and a Cloudflare Realtime TURN processor row in
  [register-of-processing](../../compliance/register-of-processing.md), marked owed review. The
  matching `/legal/privacy` paragraphs (sections 2, 3 and 4, the wording of #2013) are HELD in a
  separate draft pull request: **owed the owner's yes (Q5) before calls ship**, since merging them
  would publish a policy for a feature not yet in production.
- **The call report** (WP-C2, #2011 ported the same day): [revival plan section 6](calls-revival-plan.md#6-observability---a-call-report-that-carries-evidence).

**Wire**: `mls-webrtc-media-v2` and the AAD are INCOMPATIBLE with every build before them - audio
was sent with no AAD under one key until then. Both ends need this build; calls run on dev builds
only, so no shim exists ([legacy-compatibility](../../legacy-compatibility.md#nothing-to-remove---a-call-media-frame-is-v2-only-2026-10-21)).

## The switches agree, and a silent frame stays unread

**Two facts since 2026-10-21 (B2').** The owner decided that the first production calls ship
without the native ring, so `callsCompiled.test.ts` now reads TWO constants: the ring's four
switches (the Kotlin `CALLS_ENABLED`, the ObjC `kCanariCallsEnabled`, `voip`,
`USE_FULL_SCREEN_INTENT`) agree with `CALLS_NATIVE_RING_COMPILED`; `audio` and the microphone purpose
strings agree with `CALLS_COMPILED`; and the ring is never on while `CALLS_COMPILED` is off. Nothing
flipped: every value was `false` / absent and stays so. What the iPhone without a VoIP token is sent
for a ring (an FCM ALERT titled with the caller's name, `ringViaFcm`) is unchanged and is the owner's
call with the audio enablement. The paragraph below is the 2026-10-18 shape.

**One test, one fact (2026-10-18).** `frontend/src/lib/mobile/callsCompiled.test.ts` reads
`CALLS_COMPILED` from `features.ts` and asserts that the other switches of the table at the top
of this page AGREE with it - the Kotlin `CALLS_ENABLED`, the ObjC `kCanariCallsEnabled`, the `voip`
and (since 2026-10-20) `audio` entries of `UIBackgroundModes`, the `USE_FULL_SCREEN_INTENT` tag -
that no build step (`ios.yml`, gradle) writes a call switch in, and that the microphone purpose
string (base `Info.plist`, `fr.lproj`, `en.lproj`) names calls exactly when calls are compiled. It
replaced three tests that each asserted "off" (`iosCallDeclarations.test.ts`, two cases of
`androidFcmManifest.test.ts`, one of `pushSilentDecrypt.test.ts`): a hard-coded "off" fails the
revival commit for doing its job, an agreement fails it only when it forgets one of the six. Read
as text: it proves what is written, never what runs.

**The revival no longer reopens the Android push lane.** The Kotlin silent-frame guard used to be
`silent && !CALLS_ENABLED && isKeyDistribution != true`: flipping the switch would have decrypted
EVERY silent frame again - every read receipt, 10.7 s of Argon2 each on a Mi 9T (NOTIF-11) - to find
the rare silent `call_invite`. Nothing needs that decrypt: every current caller rings through the
cleartext `call_ring` push, sent and awaited BEFORE the MLS invite (a refused ring ends the call),
and stops it with `call_ring_end`. The guard is now `silent && isKeyDistribution != true`, identical
today (the switch is off) and unchanged by the flip; `pushSilentDecrypt.test.ts` fails if it ever
reads the switch again. The MLS `call_invite` branch below it rings nothing since 2026-10-30: a
decrypted invite skipped every rule the server's `call_ring` applies, so it is logged and dropped.

**A call is never placed across a block (WP-C7).** `initiate` refuses `403 { code: 'USER_BLOCKED' }`
when a block stands between the caller and the other member, in either direction - before a room is
bound, so no ring window opens, no invite leaves and nothing rings, in-app or native. `ring`
refuses it again before the fan-out and before the answer window opens: between `initiate` and
`ring` the caller waits on the first microphone prompt with no limit, so a block set meanwhile is
caught there, and a refused ring already ends the call on the client. `room-token` refuses the same
for a block set while the call rang; the callee asks for the token BEFORE it sends `call_answered`,
so a refused answer tells nobody it was answered (its siblings stop ringing one round trip later).
The client reads the code (`CallInitiateError.code`) and says `call_unavailable` ("this call cannot
be placed"), never who blocked whom ([moderation-and-blocking](../../moderation-and-blocking.md#what-a-block-does-exhaustively)).
A MODIFIED client that skips `initiate` and `ring` and sends the MLS `call_invite` itself does not
ring the in-app UI either: `handleCallSignal` asks `isBlockedWith` before it rings, and a failure to
ask does not ring (logged at error). Pinned by `calls.service.spec.ts`, `callFailure.test.ts`,
`CallService.callsEnabled.test.ts` and `CallService.p2p.test.ts`. **Any block with any other member
refuses the WHOLE call** - right for 1:1, which only the client enforces today; WP-C11 must decide it
for a group ([backlog](../../backlog.d/p1-blocks-production-calls-mode-what-is-owed-before-production-calls-r.md)).

## Audio quality, measured 2026-10-19

**The report.** The user: the call audio "sounds horrible", then "un bruit informe au lieu d'un son"
(a formless noise instead of a sound). The same day's phone reading (Mi 9T calling the iPhone 12,
`1.3.1-alpha.1`, [device-readings](../../device-readings-2026-10.md), CALL-AUDIO-1): clean network
(jitter 3-19 ms, ~0 loss, `host/udp`), yet the Mi 9T's NetEq logged 14,568 `Decode error` (~30 % of
the iPhone's 50 packets a second), 62 % of samples concealed, `audioLevel` 1.000.

**The rig.** [`tools/call-audio-fidelity`](../../../../tools/call-audio-fidelity/README.md): two
headless Chrome 155 processes, each with a fake microphone playing a known 12 s reference (sweep,
speech-like, tones, noise), call each other through the app's IMPORTED capture constraints, sender
parameters and E2E worker, in `CallService`'s order. The receiver records the decoded audio at
48 kHz; every decrypted payload is looked up, by a 32-bit FNV-1a hash and its length, among the
payloads the other side encoded (a membership check, not a full byte compare);
`getStats()` every second. `bun tools/call-audio-fidelity/rig.mjs` (about 45 s a row; run nothing
heavy beside it), `--reanalyze <dir>` re-scores saved recordings, `bun test tools/call-audio-fidelity`
self-tests the metrics (in `make test-ci-scripts`).

**Results** (Chrome 155 to Chrome 155, loopback, one host; `match` = median correlation of 50 ms
blocks with the reference; LSD on the speech segment):

| Row                                                                    | match | bit-exact frames | LSD dB | bandwidth Hz | dropouts (ms) | concealed % | verdict              |
| ---------------------------------------------------------------------- | ----- | ---------------- | ------ | ------------ | ------------- | ----------- | -------------------- |
| app (as shipped, E2E on)                                               | 0.98  | 1726/1726        | 3.95   | 10412        | 1 (170)       | 0           | PASS                 |
| app, far end talking                                                   | 0.98  | 1722/1722        | 4.22   | 10412        | 1 (170)       | 0.4         | PASS                 |
| app, no E2E transform                                                  | 0.98  | -                | 3.92   | 10412        | 1 (170)       | 0           | PASS                 |
| voice processing off                                                   | 0.99  | 1734/1734        | 2.67   | 19515        | 0             | 0           | PASS                 |
| app, 5 % loss                                                          | 0.94  | 1671/1671        | 5.13   | 10011        | 1 (160)       | 4.5         | PASS                 |
| no E2E, 5 % loss                                                       | 0.95  | -                | 5.06   | 10011        | 1 (160)       | 4.8         | PASS                 |
| app, 15 % bursty loss + 40 ms jitter                                   | 0.89  | 1473/1473        | 6.75   | 8067         | 4 (350)       | 13.7        | (not gated)          |
| RED first                                                              | 0.98  | 1720/1720        | 3.95   | 10412        | 1 (170)       | 0.1         | PASS                 |
| DTX on                                                                 | 0.98  | 1711/1711        | 3.96   | 10412        | 1 (170)       | 0           | PASS                 |
| callee audio on a NEW m-line, receiver transform attached in `ontrack` | 0.96  | 1754/1754        | 4.15   | 10412        | 1 (160)       | 0           | PASS                 |
| FAULT: wrong key on the callee                                         | 0.00  | 0/0              | 29.2   | -            | 7610          | 0           | silence              |
| FAULT: the sender encrypts twice                                       | 0.06  | 0/1735           | 29.3   | -            | 610           | 53.1        | loud noise, clipping |
| FAULT: no receiver transform                                           | 0.07  | -                | 48.0   | -            | 600           | 53.7        | loud noise, clipping |

**What it says.**

1. **The app's own path does not corrupt audio.** Chrome to Chrome, both directions, every role,
   clean or lossy, with RED or DTX: every decrypted payload's hash matches an encoded one and
   the output correlates 0.94-0.98 with the reference. The E2E transform costs nothing measurable
   (app vs no-E2E: same LSD, same concealment under loss).
2. **The phones' symptom has ONE signature in the rig: bytes that are not Opus reaching the
   decoder.** Ciphertext into the decoder (no decrypt, or a double encryption decrypted once) gives
   ~53 % concealment, full-scale samples and a noise floor of -13 to -21 dBFS: the Mi 9T's 62 %,
   `audioLevel` 1.000 and "formless noise". A wrong key gives SILENCE (every frame dropped), never
   noise, so the F5 key mismatch is not this defect. Random bytes break Opus's framing rules
   (RFC 6716 R1-R7) about half the time, which is the decoder's `Decode error` share.
3. **(Corrected 2026-10-20: it was the Chromium receivers - every Chromium client short-circuited
   both transforms, [CALL-E2E-BYPASS-MI9T](#call-e2e-bypass-mi9t-2026-10-20---chromium-short-circuits-a-transform-assigned-one-task-late).)** **So the fault sits on a side the rig does not run**: the iPhone's WebKit sender (WebKit's
   encoded transform handing over, or sending, something other than one encrypted Opus frame) or the
   Mi 9T's Android WebView receiver not decrypting. Both are named by the log line below.
4. **Voice processing, not the codec, sets the band**: with the app's `echoCancellation`,
   `noiseSuppression`, `autoGainControl` the sweep falls 10 dB by 10.4 kHz (tone at 10 kHz -6 dB)
   and one ~170 ms onset after a pause is gated - identical with and without E2E, absent with
   processing off (19.5 kHz). That is Chrome's standard voice chain, wideband-plus, not "horrible".
5. **Clipping under loss.** Opus concealment overshoots: 0-3215 full-scale samples per 12 s under
   5 % loss, varying run to run, with and without processing. Not gated on lossy rows.
6. **DTX and E2E.** With `usedtx=1` Chrome hands the sender transform 0-byte frames in every pause;
   the worker encrypts them into 28-byte packets, so DTX would save nothing under E2E. The app does
   not negotiate DTX.
7. **The lot 1 note above was narrower than it read** (corrected there). A receiver transform
   attached in `ontrack` for a transceiver a RENEGOTIATION created decrypts every frame in Chrome
   155 (row "new m-line"); the silence measured on 2026-10-17 was a transform attached late to a
   receiver already running.

**The change (draft PR).** The worker checks every plaintext audio payload against RFC 6716 R1-R7
(`utils/opusPacket.ts`): on the sender BEFORE it encrypts, on the receiver AFTER it decrypts, and on
a receiver payload that fails it, tries to decrypt it AGAIN - success is proof the sender encrypted
twice. It forwards everything unchanged (a witness, not a filter; the decoder rejects such a frame
anyway). `CallService` logs:

- `[Call] ERROR E2E sender: audio payload is not an Opus packet (N so far; len= toc= pt=)` - this
  device's ENGINE handed the transform something that is not Opus (or the transform runs twice);
- `[Call] ERROR E2E receiver: ...` with NO sender line on the other device - it was damaged after
  the other side's check, or arrives undecrypted;
- `[Call] ERROR E2E receiver: audio frames decrypt TWICE` - the other device encrypts twice.

Empty frames (DTX) are exempt, and so is any frame whose metadata does not NAME `audio/opus` (a RED
or CN frame is not an Opus packet; an engine that omits `mimeType` gives no way to tell). A
`getMetadata()` that throws is logged as a worker `warn` and costs no frame. The rig ASSERTS the
silence: `verdict()` fails any row whose log carries an `opusInvalid` or `doubleEncrypted` line,
and the double-encryption fault logs both sender and receiver lines from the first frame. Pinned by
`encryption.worker.test.ts` and `opusPacket.test.ts`.

**Owed on the phones (the next reading separates the hypotheses from the app log alone):**

| On which device                        | Read                                                                      | Means                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| iPhone (sender of the noisy direction) | `ERROR E2E sender` lines; the count of `E2E encrypting audio`             | WebKit's sender frames are not single Opus packets, or the transform is applied twice |
| Mi 9T (receiver)                       | `E2E decrypting audio (N frame(s))` growing at ~50/s while it hears noise | it DOES decrypt: the bytes were wrong before encryption (iPhone side)                 |
| Mi 9T                                  | no `E2E decrypting audio` at all, or `WARN late E2E receiver transform`   | its receiver is not decrypting: ciphertext reaches its decoder                        |
| Mi 9T                                  | `ERROR E2E receiver: audio frames decrypt TWICE`                          | the iPhone encrypts each frame twice                                                  |
| both                                   | the other direction (Mi 9T heard on the iPhone)                           | not read on 2026-10-19 (store build not inspectable)                                  |

**The witness may be blind on the iPhone.** It accuses only a frame whose metadata names
`audio/opus`; if WebKit's `RTCEncodedAudioFrame.getMetadata()` omits `mimeType`, the iPhone logs no
`ERROR E2E sender` line whatever it sends, so an ABSENT sender line there proves nothing. The Mi 9T
receiver (Chromium) carries `mimeType` and is the side to read.

The in-app log was batched during that reading (LOG-1); read the lines from the console live, as the
reading did. A decisive check that needs no new build: call each phone from desktop Chrome on
`dev.canari-emse.fr` (the rig's engine). The phone that plays noise from a desktop caller, or makes
a desktop play noise, is the one at fault.

### The iPhone's sender, read from the code (2026-10-19)

The desktop-vs-phone reading (device-readings, 2026-10-19) put the noise on the iPhone's SENDER:
desktop Chrome and the Mi 9T both hear it as noise (58-68 % concealed, no loss), every Chromium
pair is clean. The receivers logged no `E2E decrypt failed`, so the iPhone's frames AUTHENTICATE
under the call key and still decode as garbage: what the iPhone encrypted was not one Opus packet.
Read against the app and WebKit's source (`RTCRtpScriptTransform`, `RTCEncodedStreamProducer`,
`LibWebRTCRtp{Sender,}TransformBackend`, `RTCEncodedFrame`), ranked:

| #   | Hypothesis                                                             | For                                                                                                                                                                              | Against                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | Each frame passes the sender transform TWICE (double encryption)       | The only rig fault whose frames authenticate AND decode as noise: 53 % concealed, full scale, ~half `Decode error`. Engine-independent of codec.                                 | No path found: the app attaches one sender transform per `addTrack` (`if (sender.transform) return`); WebKit registers its backend as the frame transformer once (`m_isRegistered`), has ONE input-callback slot and replaces a previous transform's backend (`takeBackend`), not adds. |
| H2  | WebKit hands the sender transform something other than one Opus packet | WebKit-only, both initiators. `RTCEncodedFrame.data` copies the libwebrtc payload with no prefix, so it would sit in WebKit's libwebrtc audio path, which this repo cannot read. | WebKit's own tests run Opus through audio script transforms; no WebKit bug names it.                                                                                                                                                                                                    |
| H3  | WebKit negotiates and sends a non-Opus codec (RED, CN, G.722, PCMU)    | Safari's offer order was never logged.                                                                                                                                           | The answer picks a codec both sides decode, and a RED/PCMU payload decrypted intact decodes cleanly (rig row "RED first"); a codec mismatch is silence or clean audio, never noise.                                                                                                     |
| H4  | `configureCallAudioSenders`' `maxBitrate` on WebKit                    | It runs after every remote description.                                                                                                                                          | A bitrate cap changes the encoder's target, never the packet's validity; WebKit refuses a malformed `setParameters` rather than applying it.                                                                                                                                            |
| H5  | The iPhone sends some frames bypassing the transform (clear Opus)      | -                                                                                                                                                                                | A receiver drops a frame that does not authenticate (`E2E decrypt failed`, silence), it never decodes it: noise needs bytes that authenticate.                                                                                                                                          |

**The cause is NOT known, and nothing here changes what is sent.** No code path for H1 was found,
and the iPhone classes close by hardware, never by a fix against a suspected bug nobody has seen;
so the change is DIAGNOSTICS ONLY, built so the next iPhone call separates the hypotheses from the
app log alone. The worker forwards every frame as before; the rig row "the sender encrypts twice"
stays a FAULT row, and shows the receiver's `decrypt TWICE` witness firing.

**The diagnostic** (no payload byte leaves the worker; a clean call adds three lines per device):

- `[Call] E2E sender transformer #N (K sender in this worker): first frame audio mime= pt=` - ONE
  line per transformer. One sender per track: a second audio `sender` count in one call is a
  double attach, and `mime`/`pt` is the codec WebKit feeds the transform (H3).
- `[Call] E2E sender audio #N: F frame(s), not-opus= repeated-ts= own-iv= len=min..max avg= toc=configC/codeK (P%)`
  once after 50 frames, then every 1500 frames (~30 s) ONLY while an anomaly counter is non-zero,
  as `ERROR`. `own-iv` counts inputs that START with one of the last 64 IVs this worker produced:
  its own output handed back, a double pass (H1), exact and with no decrypt. `repeated-ts` counts
  RTP timestamps the same transformer already saw (one frame handed over twice). `not-opus` is H2
  (on an engine that names `audio/opus`), and `len`/`toc` say what the input looks like.
- `[Call] audio send=<mime> pt= ch= [fmtp] recv=... | local m=audio <order> | remote m=audio <order>`
  3 s after `connected` - the codec each direction is BOUND to, and both SDPs' offer order (H3).

**What the next iPhone call must show** (a dev pre-release, the iPhone calling or called by desktop
Chrome, the iPhone's log read live):

| iPhone log                                                     | Desktop hears | Means                                                                          |
| -------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `own-iv` > 0, or two `sender transformer` lines for audio      | noise         | H1: each frame passes the transform twice; the transformer lines name which    |
| `not-opus` > 0, `own-iv=0`                                     | noise         | H2: WebKit hands the transform non-Opus; `len`/`toc` say what                  |
| `repeated-ts` > 0, `own-iv=0`                                  | noise         | WebKit hands the same frame over twice (two plaintext copies)                  |
| all zero, `mime=audio/opus`, `audio send=audio/opus`            | noise         | the bytes go wrong AFTER the worker (WebKit's packetiser): not ours to see     |
| `mime`/`audio send=` not Opus                                  | noise         | H3: the codec WebKit actually sends                                           |
| all zero                                                       | clean         | not reproduced on that build: read again before anything else                  |

### The Mi 9T logged no worker line at all (`1.3.1-alpha.2`) - the worker is now ASKED

**What was read** (device-readings, `1.3.1-alpha.2`, five calls, both roles): the Mi 9T logged the
main thread's `E2E sender/receiver transform attached` and `audio send=` lines and NOTHING the
worker posts - no `transformer #N`, no `sender audio #N`, not even the first-frame `E2E
encrypting/decrypting audio (1 frame(s))`.

**What the code rules out.**

- The worker IS started and its messages DO reach the main thread at least once: both `attached`
  lines are written only after `ensureWorkerKeyReady` received the worker's `keyReady`.
- The bridge logs every kind it is sent (`getOrCreateEncryptionWorker`), and `appendLog` is a bare
  `console.log`.
- Nothing is rate-limited past the first frame: `transformer` and `encryptOk`/`decryptOk` post on
  frame 1, the sender shape on frame 50 (1 s).
- There is ONE transform path (`RTCRtpScriptTransform`; the legacy `createEncodedStreams` was
  removed in lot 1).

**What the readings rule out.** On `1.3.1-alpha.1` the Mi 9T paired with desktop Chrome was CLEAN
both ways (0 decode errors, [device-readings](../../device-readings-2026-10.md)). Desktop Chrome
encrypts (the rig taps it), so the Mi 9T's receiver transform decrypts, and its sender transform
encrypts: frames DO reach the Mi 9T's worker. **So the likely fault is posts from inside the
transform not reaching the main thread on Android WebView 152**, not a transform that is off. That
is an inference from two builds; the next reading settles it. **REFUTED 2026-10-20**: both Chromium
ends were bypassing, so the clean pairing carried clear audio, see [CALL-E2E-BYPASS-MI9T](#call-e2e-bypass-mi9t-2026-10-20---chromium-short-circuits-a-transform-assigned-one-task-late).

**Desktop Chrome 152 does not reproduce it.** The rig run on Chrome for Testing 152.0.7977.82 (the
WebView's major) and on 155 shows every transform-context line and the transform in the path:
1,721-1,726 sender frames and 1,747-1,820 receiver frames per 34 s.

**The change.** The worker counts every frame each side is handed, BEFORE anything can drop or
throw, and answers `{ type: 'report' }` from its `onmessage` - the path `keyReady` already crosses
on the Mi 9T. `CallService` asks twice per call, 5 s after the first `connected` and at the end
(before the worker is terminated), and logs ONE line each (`utils/callE2eReport.ts`):

```
[Call] E2E worker report (5 s after connected): transformers sender=1 receiver=1 | frames in sender=250 receiver=251 | encrypted audio=250 video=0 | decrypted audio=249 video=0 | decrypt-failed=0 short=2 (empty 2) no-key=0 not-opus sender=0 receiver=0 double=0 | engine=Chrome/152 attr sender=native receiver=native
```

Rules for the line:

- It starts `ERROR` when a side has no transformer or no frame, or when non-Opus audio crossed.
- A missing NATIVE `transform` attribute (`sender.transform = x` would then be a plain property) is
  a fact, not a verdict: with a side at 0 frames it joins the `ERROR` ("the media may flow around
  the worker"); with both sides fed it is a note, without `ERROR`.
- "No frame" is judged at the end of a call ONLY if the 5 s report ran: a call hung up a second
  after connecting may legitimately have received nothing. Decided by which report ran, not a clock.
- The end line carries the call id: `(call end, call=<id>)`.
- No answer within 1.5 s is its own `ERROR ... the worker did not answer` line.
- A call that never connected owes no report.

**The receiver's silent drop is counted too.** A receiver frame shorter than an IV was dropped with
no trace. The rig shows they exist: 18-39 EMPTY frames per 34 s on Chrome 155, 110 on 152, none
from the app's sender. They are counted in `short=` (empty ones without a line), and a non-empty
one is named.

**The rig.** It asks the same report and FAILS an E2E row whose sender or receiver transform saw no
frame (`transform-in-path`). The FAULT row "no receiver transform" now fails on it too: tx=1722,
rx=0. Pinned by `callE2eReport.test.ts`, `encryption.worker.test.ts` and `CallService.p2p.test.ts`
("the E2E worker report").

**What the next phone call must show** (Mi 9T, each line read from its console):

| Report line on the Mi 9T                                               | Means                                                                                                                                                          |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| present, frames in sender/receiver ~250 each at 5 s, `decrypted` close | the transform IS in the path; the per-frame lines are lost because posts from inside the transform do not reach the page on this WebView. Read `not-opus` here |
| `the worker did not answer in 1500 ms`                                 | once a transform is attached, nothing the worker posts reaches the page (`keyReady` came before)                                                               |
| `transformers sender=0` or `receiver=0`                                | the engine never handed the worker that side's transformer                                                                                                     |
| transformers 1, `frames in` 0 on a side                                | the transformer exists and is never fed: media flows around it                                                                                                 |
| `attr ... absent` with a side at 0 frames (`ERROR`)                    | this WebView may route media around the worker: read the other device for `E2E decrypt failed` before calling it unencrypted                                   |
| `attr ... absent`, both sides fed (a note)                             | the attribute is missing but the transform runs; not a fault by itself                                                                                         |
| `not-opus receiver` > 0 while hearing the iPhone                       | the iPhone's frames decrypt to non-Opus (H2/H1 above); `double` > 0 is H1                                                                                      |

**The desktop counterpart is a command now.** `tools/cross-client-harness/callpeer.mjs` starts a
harness profile with a fake microphone, tracks the page's peer connections, can dial or accept, and
prints the RECEIVER's concealed %, loss, jitter and codec every 5 s. It also writes the samples and
every `[Call]` line (the worker report included) to a JSON file. The by-hand reading of 2026-10-19
becomes `bun callpeer.mjs --browser w3 --launch --url https://dev.canari-emse.fr/chat --accept`
([README](../../../../tools/cross-client-harness/README.md#callpeermjs---a-desktop-chrome-as-the-other-end-of-a-phone-call)).

**TURN / server.** Every row runs `host/udp` on loopback; nothing here exercises TURN. The phone
reading's `TURN CreatePermission error response` (403 and 600, CALL-TURN) is NOT a credential
fault: Cloudflare refusing relay pairs to private or IPv6 peers that could never carry media, none
when both ends relay; and the relayed path itself carries clean E2E audio over UDP, TCP and TLS 443
([readings, 2026-10-20 afternoon](../../device-readings-2026-10.md#2026-10-20-afternoon---v131-alpha4-across-networks-forced-relay-tcp-and-tls-turn-a-nated-hotspot)).

## Group calls - a peer-to-peer mesh up to 4 in audio, 3 in video (owner decision D-A, 2026-10-31)

**Decided, not built** - the input of WP-C11
([revival plan](calls-revival-plan.md#10-the-work-packages-in-order)). A group call is a mesh of the
1:1 peer connections this page describes, one per other participant, up to **4 participants in
audio and 3 in video**; beyond that a relay SFU carries it. The numbers come from the Q3 mesh probe
([revival plan, section 14](calls-revival-plan.md#14-probes-of-2026-10-16-clients)): every
receiver costs the SENDER one more encode, and the Mi 9T encoding 720p for two receivers already
dipped to 18-23 fps at 19-24 ms of encode per frame per receiver, while audio is capped at
48 kbit/s a peer (`AUDIO_BITRATE_VOICE`; ~50 kbit/s on the wire in the audio rig), ~150 kbit/s up
for a 4-way mesh. **The mesh-to-SFU switch when one more person joins is an OPEN design point**,
with the SFU choice (WP-C4), per-sender keys and the TURN volume of a relayed mesh:
[backlog](../../backlog.d/group-calls-p2p-mesh-up-to-4-audio-3-video-decided-2026-10-31.md).

## Noise suppression (RNNoise) - decided 2026-10-31, built, its clean-speech row fails

**The decision (owner, D-B, 2026-10-31).** The call microphone goes through RNNoise, ON by
default, with an in-call switch to send the raw capture instead (music).

**Amended (owner, 2026-11-01): it ships OFF by default.** The in-call switch stays; every call
starts OFF (`CALL_NOISE_SUPPRESSION_DEFAULT = false`), and the switch turns it ON for that call.
It goes back to ON by default only after a REAL call on the bench phones sounds good with it on -
the gated clean-speech row below failed. OFF builds nothing: no AudioContext, no worklet, no wasm
fetched until the first ON of the call (`CallMicSwitch.ensurePipeline`, one build per call, inside
the tap). `[CALL_REPORT] ns=off` is therefore the ordinary value; `ns=on`, `pending` or
`unavailable` appear only in a call where someone turned it on.

**Its lifetime is the call's, with no clock (review of #2831).** A build still waiting on the
worklet's `ready` is cancelled by the call's end (`CallMicSwitch.close` aborts its `AbortSignal`):
it settles `cancelled` and closes its context, worklet and source. Switched OFF, the context is
SUSPENDED (no RNNoise runs for a track nobody sends); switched ON, it resumes inside the tap.
`usable()` reads the context's state, which an engine may report `running` while the worklet no
longer processes, so each 10 s `[CALL_REPORT]` tick also reads the worklet's frame count (it
reports every 5 s): while the processed track is sent, a count that did not advance since the last
tick sends the raw capture again - `WARN noise suppression stopped processing`, counted in
`ns_fallbacks`, `ns=unavailable` for the rest of the call.

**The mechanism.** `utils/callNoiseSuppression.ts` builds `raw capture -> MediaStreamSource ->
AudioWorkletNode (workers/rnnoise.worklet.ts) -> MediaStreamDestination` in a 48 kHz
`AudioContext`. RNNoise is xiph's (BSD-3-Clause), compiled to wasm by `simple-rnnoise-wasm`
(MIT, pinned `1.1.0`, bundled by Vite as an asset of the app's origin - no CDN); the worklet is the
app's own code, and the wasm's `pipe` buffers 128-sample quanta into RNNoise's 480-sample 10 ms
frames (~10.7 ms added). The capture keeps the browser's echo canceller
(`buildCallAudioConstraints`, unchanged), so RNNoise runs AFTER AEC. **The call never waits for
it**: `addTrack` takes the raw track, and `CallMicSwitch` moves the SAME sender to the processed
track with `replaceTrack` once the worklet has PROVEN it processes (`ready` after its first
quantum) and while its context runs; a context the engine suspends sends it back to raw, loudly.
`replaceTrack` changes the track, never the sender, so the E2E transform stays in the path and
nothing renegotiates (the rig's `transform-in-path` and bit-exact frames on the `ns` rows say so).
The switch is the top-row `AudioLines` button of `CallOverlay`, hidden where the pipeline could not
be built.

**The primary path failing is a signal.** No AudioWorklet or MediaStream destination (the feature
test, before any context), a refused context, a context not at 48 kHz, a worklet module or wasm
that does not load, a worklet scope without WebAssembly: `[Call] WARN noise suppression unavailable
(<cause>: <detail>) - the raw microphone is sent`, and the call goes on. `[CALL_REPORT]` carries
`ns=on|off|pending|unavailable` and `ns_fallbacks=<n>` (builds failed, processed paths that stopped,
`replaceTrack`s refused); `ns=pending` for a whole call is a worklet that never proved it ran. At
the end, ONE line: `[Call] noise suppression end: ns= ns_fallbacks= frames= cost_ms_per_frame=
realtime_pct= max_quantum_ms= clock=` - the worklet's time per 10 ms frame. Chrome's
AudioWorkletGlobalScope has no `performance`, so the clock is `Date.now()` (1 ms steps, averaged
over thousands of quanta).

**Measured (the audio rig, Chrome 156 to Chrome 156, 2026-10-31, `--seconds 36`).** Scored against
the CLEAN reference; `noisy` = the reference under steady band noise + hum 10 dB below speech.

| Row | match | speech LSD dB | HF tilt dB | bandwidth Hz | dropouts (ms) | floor dBFS | cost ms / 10 ms frame | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| app (switch OFF, as before D-B) | 0.98 | 3.95 | -3.2 | 10412 | 1 (170) | -88.5 | - | PASS |
| **app-ns** (switch ON, the default) | 0.90 | 11.02 | -14.8 | 8556 | 10 (1340) | -100.2 | 0.26 | **FAIL**: match, lsd, hf-tilt, bandwidth, dropouts, clipping |
| raw (no browser processing) | 0.99 | 2.63 | -0.6 | 19515 | 0 | -117.1 | - | PASS |
| raw-ns | 0.98 | 7.05 | -11.4 | 19515 | 4 (270) | -114.1 | 0.01 | FAIL: lsd, hf-tilt, dropouts |
| app-browser-ns-off-ns (browser NS off, AEC/AGC on) | 0.90 | 12.50 | -16.3 | 13439 | 9 (1170) | -83.1 | 0.17 | FAIL |
| app-noisy (switch OFF) | 0.98 | 12.75 | -7.5 | 8556 | 1 (150) | -50.0 | - | (experiment) |
| app-ns-noisy | 0.86 | 12.35 | -11.4 | 6760 | 7 (1900) | -75.1 | 0.23 | (experiment) |

**What it says.**

1. **It works as built**: every `ns` row sent the processed track to the end with 0 fallbacks,
   every decrypted frame bit-exact - the E2E path is untouched by the `replaceTrack`.
2. **It removes a steady background**: the floor between segments falls from -50 to -75 dBFS on
   the noisy reference (-69 with the browser's suppressor off).
3. **It FAILS the clean-speech gate**, the acceptance condition the brief set: on the rig's
   speech-like reference RNNoise cuts the high band (HF tilt -15 dB against -3), gates syllables
   (1.3 s of dropouts against 0.17) and doubles the spectral distance. RNNoise alone (`raw-ns`)
   is milder but still over the LSD and dropout bars; turning the browser's suppressor off does
   not help. **Caveat**: the reference is SYNTHETIC speech (harmonic syllables, noise-burst
   fricatives), and RNNoise was trained on real voices - the fricative bursts are exactly what it
   reads as noise. Whether a real voice fares better is a phone reading, not a rig number.
4. **Cost on the desktop: 0.01-0.26 ms per 10 ms frame (0.1-2.6 % of one core in real time)**;
   the Mi 9T's number is owed.

**Owed** ([backlog](../../backlog.d/call-noise-suppression-clean-speech-gate-fails-and-readings-owed.md)):
the owner took the call on row 3 (OFF by default, 2026-11-01, above); what turns it back ON by
default is a real call on the bench phones that sounds good with the switch on. The readings, each
in a call where the switch was turned ON - `ns=on` and the end line on the Mi 9T (Android WebView)
and the iPhone 12 (WKWebView, AudioWorklet since iOS 14.5; whether its worklet scope has
WebAssembly, and whether a second AudioContext moves the call's audio route), the switch turned on
in a call answered from the native ring, a real voice and music with the switch on and off.

## CALL-E2E-BYPASS-MI9T (2026-10-20) - Chromium short-circuits a transform assigned one task late

**The reading** ([device-readings](../../device-readings-2026-10.md), `1.3.1-alpha.3`): on the Mi 9T
the worker report said `transformers sender=1 receiver=1 | frames in sender=0 receiver=0`, `attr
native`, in ten reports over five calls, while audio flowed both ways; the iPhone failed to decrypt
every frame from the Mi 9T; the screen said "Appel chiffre de bout en bout".

**The cause, measured on the Mi 9T itself** (its WebView `Chrome/152.0.7977.64`, driven over CDP
from the running app's page, no new build), with a two-peer-connection loopback inside the WebView,
an oscillator or the microphone, and either a counting blob worker or the APP's own
`encryption.worker` keyed through its `setKey`:

| Where the transforms are assigned | frames in (sender / receiver, per side, ~4 s) | packets |
| --- | --- | --- |
| synchronously after `addTrack` / on its transceiver (the rig's order) | 188-196 / 188-195, every frame decrypted by the app's worker | flowing |
| after an `await Promise.resolve()` (a microtask) | 191-194 / 191-194 | flowing |
| after a `setTimeout(0)` (ONE task) | **0 / 0**, transformers 1 / 1 | **flowing** |
| after a worker round trip (what `ensureWorkerKeyReady` was) | **0 / 0**, transformers 1 / 1 | - |
| after the offerer's `setLocalDescription` / the answerer's `setRemoteDescription` | **0 / 0**, transformers 1 / 1 | flowing |

Desktop Chrome 155 (headless) gives the same two rows (microtask fed, one task 0 / 0). So Chromium
decides at the end of the task that created a sender or transceiver: no transform by then, and it
is SHORT-CIRCUITED for good. The transform assigned later still gets its `rtctransform` event (the
worker counts a transformer), `sender.transform` reads back set, and nothing is ever handed to it.

**What the app did.** `initPeerConnection` called `pc.addTrack(...)`, then `await
setupSenderTransform(sender)`, whose first statement awaited `ensureWorkerKeyReady()` - the FIRST
use of the worker, so a script load plus a `setKey`/`keyReady` round trip: a task boundary, on every
engine. So on EVERY Chromium client (Android WebView, desktop Chrome, the Tauri desktop apps) both
transforms were short-circuited: clear Opus left, and received frames went to the decoder as they
arrived. WebKit has no such short-circuit; the iPhone really encrypted.

**What that reconciles.**

- Mi 9T and desktop Chrome, CLEAN both ways on `1.3.1-alpha.1`: BOTH bypassed - clear Opus both ways,
  decoded perfectly, **no E2E at all**. Reproduced in the rig: row `fault-transform-late` scores match
  0.98, 0 % concealed, with `transform frames tx=0 rx=0`. Clean audio was never evidence of E2E.
- iPhone to Mi 9T or desktop, NOISY (56-70 % concealed, ~14.5 `Decode error`/s): the iPhone's
  ciphertext fed to a Chromium decoder - the rig's `fault-no-decrypt` signature (53 % concealed,
  ~half the frames rejected). **CALL-AUDIO-1 is this defect**, and "the iPhone's SENDER is the faulty
  side" (2026-10-19) was the wrong side: the iPhone was the only one encrypting.
- iPhone receiving the Mi 9T: clear Opus authenticates under nothing - `decrypt-failed` on every
  frame, silence on the iPhone.
- The rig never saw it: it keys its worker BEFORE `addTrack` and assigns synchronously, so it
  measured an order the app did not have. `fault-transform-late` now runs the app's old order and
  must fail `transform-in-path` (it does: tx=0 rx=0, audio clean).

**The fix (primary path).**

1. `setupEncryption` puts the key INTO the worker (`ensureWorkerKeyReady`, logged `E2E worker holds
   the call key`) before signalling is joined, so before any track exists.
2. `attachSenderTransform` / `attachReceiverTransform` are SYNCHRONOUS and THROW when the worker holds
   no key (`keyedWorker`). `initPeerConnection` does `addTrack` and both transforms of its
   transceiver with nothing awaited between them; so does `toggleVideo` (and removes the camera
   sender if an attach throws, before any negotiation carries it); `handleRemoteTrack` attaches a
   new m-line's receiver in the `ontrack` task.
3. Pinned by `CallService.p2p.test.ts`: the fake worker now answers `keyReady` in a TASK of its own,
   as a real worker does, and the fake sender/receiver records a transform assigned after its
   creating task (`late`) - the old code fails it.

**No claim without evidence, and no call around the worker.**

- `CallService.e2eProven` is `true` only once this call's worker has posted `encryptOk` AND
  `decryptOk` (a frame encrypted, and a frame from the peer decrypted under the call key). The call
  screen shows "Appel chiffre de bout en bout" on that store and "Verification du chiffrement..."
  until then (`CallOverlay`, `call_e2e_verifying`).
- From the 5 s report on, `checkE2eInPath` reads the peer connection's RTP packets
  (`rtpPacketCounts`) against the worker's frames (`e2eBypassedSides`): packets sent with no sender
  frame, or packets received with no receiver frame, judged against the PREVIOUS check's packets
  (below), is media around the worker - logged `ERROR E2E path check: media
  flowed AROUND the transform on ...`, and the call ENDS with `CallE2eBypassedError`, read to the user
  as `call_e2e_bypassed`. A worker that does not answer, or stats that cannot be read, WITHDRAWS the
  claim (`e2eProven` back to false, `WARN E2E claim withdrawn`), whatever it proved before: what
  cannot be read cannot be verified. The check is re-armed, the silent worker's ERROR is logged once
  per silence (`the worker answers again` ends it), and frame evidence alone (`inPath`) does not
  bring the claim back - only an answered, conclusive check does. This is a PROOF from two counters,
  not a deadline, and it does not replace the ordering: a bypass of media that flows when a check
  runs is ended by the NEXT check (two checks, about 10 s, after the media starts); media that only
  starts later is judged once something starts it (below).

**The same class, one step removed: a transceiver the PEER's offer created** (review of #2158,
measured on the Mi 9T 2026-10-20 in the same loopback: one side sends two audio m-lines, the other
one, so `setRemoteDescription` creates the second transceiver; later `addTrack` REUSES it):

| The reused, offer-created transceiver | its sender's frames | packets on that m-line |
| --- | --- | --- |
| receiver transform assigned in `ontrack` | (receiver) 293-299, fed | flowing |
| sender left bare in `ontrack`, transform assigned in the SAME task as the later `addTrack` | **0**, transformer 1 | ~205 out, in clear |
| the same, transform one task after `addTrack` | **0** | flowing |
| sender transform assigned in `ontrack` too, `addTrack` later | 203, fed | flowing |
| a FRESH `addTransceiver` instead, transforms in its task | 201, fed | flowing |

So Chromium decides when the transceiver is CREATED, by `setRemoteDescription` as by `addTrack`. The
app's `toggleVideo` would have reused the peer's video transceiver for the camera, sent it clear,
and kept the screen's claim. Now: `handleRemoteTrack` attaches the receiver AND the sender of the
transceiver in the `ontrack` task, and `toggleVideo` always creates a FRESH transceiver
(`addTransceiver`). The rig shows both: `late-reuse` (the app's path now) PASS, tx=1753;
`fault-reuse-bare-sender` (the old path) silence, tx=0.

**The path check, per kind and per peer connection.** Each transform carries its peer connection's
`epoch` (`transformEpoch`, never reset); the worker counts frames as `<epoch>|<side>|<kind>`
(`framesInBy`) and posts `inPath` once per transformer on its first frame encrypted or decrypted.
`checkE2eInPath` judges this read's frames against the PREVIOUS check's packet counts, audio and
video apart, on the current epoch only: a kind is a bypass only if it had packets at check N-1 and
still no frame at check N. **Reading packets before frames in the SAME check is not enough** (review
of #2159): it holds for the sender (a frame passes the transform before its packets leave), but
`packetsReceived` counts PACKETS and a video frame reaches the receiver transform only once all its
packets are in, so a peer camera whose first packets landed just before the read has packets and no
frame - a healthy call checked early by a joined trigger would have ended. A kind with packets and
no frame and no earlier reading is too YOUNG: re-checked, never judged. It runs 5 s after each peer connection's first `connected`, after
the camera is added and after a new remote m-line (`scheduleE2ePathCheck`). A rebuilt peer connection (`onPeerReady` for a replaced device) resets the
evidence and the check; evidence from an older epoch or another call's worker is logged and lends
nothing. A transform that cannot be attached ends the call with a typed `CallE2eSetupError`
(`call_e2e_setup_failed`), never "connection lost".

**When the check runs, and when it may not conclude** (review of #2158, S1/S2). Zero packets of a
kind is no leak, and no proof either: a camera whose negotiation outlasts the 5 s delay would have
passed trivially and never been looked at again, the claim already on. So:

- A pending check KEEPS its deadline; a later trigger only adds its reason (`5 s after connected,
  after the camera was added`). Re-arming on every trigger could postpone it for ever.
- `inconclusiveMedia` lists what the check could not judge: an m-line this side sends on that is not
  negotiated yet (`currentDirection` null), or a negotiated direction whose kind carried no packet.
  So does a kind with packets and no frame yet. Anything listed re-arms the check
  (`CALL_E2E_PATH_RECHECKS`), a budget BY COUNT, logging one line per CHANGE of what it cannot judge
  and no report per re-check. Past it the check logs a WARN and WITHDRAWS the claim, and the next
  event that starts media re-checks with a fresh budget (`recheckE2eOnMediaStart`): signalling back
  to `stable` (a completed negotiation, or a rollback - one more look, never a verdict), a remote
  track unmuting, or ANY local track this peer connection sends unmuting - the initial microphone
  and camera (`initPeerConnection`) as well as a camera added mid-call (`toggleVideo`): a track muted
  by the OS starts sending with no negotiation. A conclusive check resets the budget and returns a
  withdrawn claim.
- A check that lists `carried packets, no frame yet` ALWAYS schedules its next check, OUTSIDE the
  budget: that verdict is one check away (a frame through the transform, or a bypass against this
  reading), so the state cannot repeat, and spending the budget must never drop it.
- **A healthy call LOSES the claim, by design**: a negotiated camera the OS keeps muted sends nothing,
  so after the budget (6 re-checks, about 35 s after it was added) the screen goes back to
  "Verification du chiffrement..." and stays there until video starts. Nothing is ended - zero
  packets is no leak - but nothing was verified either.
- A check whose peer connection was replaced while it waited is dropped BEFORE anything else: it may
  not withdraw the new one's claim. A rebuild also resets `e2eReportFired`, so the end report judges
  the new peer connection's frames only once its own check ran.
- Per KIND, not per m-line (review L2): a transform does not know its `mid`, so the worker cannot
  key by it, and the app carries at most one media-carrying m-line per kind and direction - the
  camera's fresh transceiver sends, the peer's offer-created one receives. Keying by `mid` would need
  the mid passed in the transform options at attach time, which an offer-created transceiver only
  has once negotiated; not worth it while that holds. **Two limits of comparing CUMULATIVE per-kind
  counts**: a second m-line of the same kind (two cameras, or a screen share sent as video) would let
  one fed transform mask a short-circuited one, so the day the app sends one, keying by `mid` is owed;
  and padding or probe packets (bandwidth estimation, RTX) count in `packetsSent` with no frame
  behind them - not measured: a call whose only video packets are probes before the first frame
  would read `carried packets, no frame yet`, and one with probes and no frame two checks running
  would be accused. Unverified on the engines; a reading owed before calls are compiled in.
- The reports name the peer connection they judge (review L3): after a rebuild the worker's lifetime
  counts include the dead one's frames, so the 5 s and the end report print and judge
  `frames in ... (peer connection N)` from `framesInBy`.
- `ontrack` names the side that threw (`E2E sender transform failed in ontrack (video)`), and the
  offer-created sender it arms logs `armed, no track yet` - it sends nothing until a later `addTrack`.

**What is still owed, on the phones** (a dev pre-release with this change):

| Read | Expected |
| --- | --- |
| Mi 9T report, both roles, iPhone and desktop as peers | `frames in` ~250 per side at 5 s, `E2E path check: PASS - all media went through the E2E transform` (worded `no media around the transform` before 2026-10-30), `E2E proven` within a second of `connected` |
| Mi 9T hearing the iPhone | no NetEq `Decode error` flood, concealed near 0 % (CALL-AUDIO-1 closes here or it was not this) |
| iPhone hearing the Mi 9T | `decrypted audio` growing, `decrypt-failed` ~0, the voice audible |
| desktop Chrome via `callpeer.mjs` | the same report as the Mi 9T |
| a call to an OLD (`<=1.3.1-alpha.3`) Chromium client | its clear media fails every decrypt here; the new side's own transforms are fed, so it is not ended by its check, but the OLD side never gets `e2eProven` - expected, dev-only |

## Video (lot 2, 2026-10-20) - VP8 behind a clear header, held by every transceiver

**What was there.** Every piece of plumbing and none of the framing: `toggleVideo` already put a
first camera on a FRESH `addTransceiver` with both transforms in its task, `ontrack` armed both
transforms of a peer-created video transceiver, the path check judged `sender:video` and
`receiver:video` on their own, and the overlay had a remote `<video>` and a mirrored corner. But the
worker encrypted a video frame WHOLE, nothing chose the codec, `track.enabled = false` was the
camera's off (camera light on, black frames sent), there was no switch, and `CALLS_VIDEO_ENABLED`
was `false`.

**Why a whole-frame encryption cannot carry video - measured, not argued.** The receiver's RTP
depacketiser runs BEFORE the receiver transform and reads the codec's payload header itself. Two
experiment rows of the rig (below) settle it on Chrome 155:

| Row                 | What it does                         | Result over 34 s                                                                                              |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `video-whole-frame` | VP8 encrypted whole (the old worker) | decodes 29.9 fps, but **503-520 key frames decoded** (two runs): the P bit is random, half the deltas read as key frames |
| `video-h264`        | H.264 negotiated, encrypted whole    | the receiver transform is handed **0 frames**, 0 decoded, 2209 sender frames counted `not-vp8` - the packetiser found no NAL units                  |

**The design** (`utils/callVideoFrame.ts`, `workers/encryption.worker.ts`, `utils/callVideo.ts`):

- **A VP8 frame keeps its payload header in clear** (RFC 6386 section 9.1): 10 bytes of a key frame
  (frame tag, start code, width, height), 3 of an interframe (frame tag). Layout
  `header || IV(12) || AES-GCM(rest)`, the header bound as **additional data** - altered on the way,
  the frame does not decrypt (counted in `decryptFailuresBy.video`). It reveals key-or-delta, the
  partition size and the picture size, never a pixel - the layout of WebRTC's own e2ee sample.
  Audio had no prefix and no AAD until 2026-10-21; since then EVERY frame's additional data starts
  with `canari-call-v2|<kind>` and each direction has its own key ([above](#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only)).
- **Every video transceiver is held to VP8 (+RTX)** by `setCodecPreferences` - the camera's, and the
  one the peer's offer created (in `ontrack`), so whichever side offers, the answer can only be VP8.
  WebKit lists H.264 FIRST; nothing here relies on the order.
- **NO FALLBACK, EITHER WAY.** An engine that cannot list VP8 or has no `setCodecPreferences`
  never opens the camera (`call_camera_unavailable`, ERROR line); a transceiver that refuses the
  preference has its sender removed before any negotiation carries it. A video frame that still
  names another codec is encrypted WHOLE (it cannot decode) and counted `not-vp8` - the worker
  report then leads with ERROR and the call logs one `ERROR E2E: video frames of <mime>, not VP8`
  line. Never a clear frame. **The frame's own check FAILS CLOSED**: an engine whose frame metadata
  names no codec is not read as VP8 - its frames are encrypted whole and counted, the clear split
  is taken only on the engine's word (`setCodecPreferences` stays the real guard).
- **Short frames are handled the same way on both sides**: an EMPTY video frame is passed through
  untouched by sender and receiver (it carries nothing); a non-empty one shorter than its header
  (not a frame an encoder emits) is DROPPED by the sender and counted (`short-sent`) - framed whole,
  the receiver would read its first IV byte as a header and split it elsewhere. A flipped P bit
  moves the split (3 read as 10, or 10 as 3) and the frame does not decrypt: the header LENGTH is
  bound too (worker test).
- **No E2E replay window.** Nothing in the frame layout numbers frames: a frame replayed inside the
  same call decrypts. Replay is covered hop by hop by SRTP (DTLS-SRTP keys per peer connection),
  as for audio since lot 1; a relay that is not a party cannot inject.
- **The audio IV window stays audio's**: the ring the double-encryption probe reads holds audio IVs
  only, so 30 video frames a second never flush it.
- **Camera OFF** stops the capture (the light goes out), `replaceTrack(null)`, direction
  `recvonly`: the peer's track MUTES and its screen shows the avatar (`remote track muted`). **ON
  again** hands a new capture to the SAME sender, `sendrecv` - its transform stays attached and fed
  (rig `video-off-on`). The first camera of a call that had none is a FRESH transceiver, as before.
- **Switch** stops the current capture first (a phone opens one camera at a time), opens the other
  with an EXACT `facingMode` (the first capture is IDEAL; one builder, `facingConstraint` in
  `utils/cameraFacing.ts`, shared with the reel and live cameras), `replaceTrack` on the same sender. A switch that cannot open the other
  camera turns the camera OFF, said (`call_camera_switch_failed`) and logged at ERROR - never a
  silent keep of the old one. Offered only when `enumerateDevices` lists two cameras.
- **One camera operation at a time, OFF always wins**: a tap while an on or a switch is still
  opening the camera means OFF and is QUEUED, applied when that operation ends. A capture that
  resolves after its call ended - or after ANOTHER call began, the permission prompt still up - is
  stopped and never adopted (the operation remembers its call id and local stream).
- **The background turns the camera OFF for real** (the same `cameraOff`: capture stopped, peer
  sees the avatar) and the return turns it ON again; never `track.enabled = false`, which kept the
  capture open and sent black frames. A button tap meanwhile cancels the automatic resume.
  **Read from BOTH signals since 1.5.2** (`onAppScreenChange`, `utils/appForeground.ts`): until
  then it listened to `visibilitychange` alone, which an Android WebView never fires - it reports
  `visible` in the background - so on Android the OS took the camera, `onended` turned it off as
  `ended by the system` and nothing turned it back on (found in the review of #2711). It now
  follows `canari:foreground` too, and a camera the OS ends while the app is OFF SCREEN is the same
  background pause, resumed at the return; one ended on screen (another app took it) stays off.
  Pinned by `CallService.p2p.test.ts` ("on Android, where the WebView stays visible").
  **Two races closed with it (re-review of #2711):** only a camera HEADED ON is paused
  (`cameraHeadedOn`: the running operation's target unless an off is queued, else the state), so an
  off the user tapped - in flight, or queued behind an opening camera - never comes back at the
  return; and Android's CAMERA permission dialog pauses the activity, so the pause's off queued
  behind the FIRST camera-on is cancelled at the return instead of turning the camera off right
  after the grant. A return while the pause's own off still runs is applied when that off ends. A
  camera the OS ends off screen is a pause only when it was headed on, too. And a camera operation
  that outlives its call (hung up mid-operation, another call begun) releases nothing of the next
  call: `endCameraOp` and `cameraOff` act only for the call their token names.
- **720p at 30 fps at most, moved by a quality ladder** since 2026-10-21 (it was a fixed 640x480,
  700 kb/s): [the quality ladder](#the-quality-ladder-2026-10-21---720p-and-an-automatic-drop).
  The rung is on the SENDER's encodings, so it survives a switch.
- **The screen**: the peer's picture full screen only while its track is live AND unmuted (else the
  avatar); the self view full screen until there is a peer picture, then a corner (landscape-aware);
  mirrored for the front camera only; `cover` when the peer's picture is held the way this screen
  is, `contain` when not (read from the picture's own `resize`). The ring says `Appel video entrant`.
  The bar keeps the camera on (as every phone) and carries a camera-off button and the peer's
  thumbnail. The screen stays on while a picture shows (wake lock, [background](#the-call-in-the-background-2026-10-19)).
- **The report**: the worker line adds `video frames in sender=.. receiver=.. encrypted=..
  decrypted=.. decrypt-failed=.. keyframes-in=.. not-vp8=..` on a call that carried video (an audio
  call's line is unchanged), and a conclusive path check adds the decoder's own numbers
  (`describeVideoStats`: size, fps, frames decoded, key frames, freezes, PLI, the send limit, and
  since 2026-10-21 the encoder `enc=` and its mean encode time per frame `encode_ms=`).

**Measured in the rig, 2026-10-20** (Chrome 155 to Chrome 155, fake camera at 30 fps, 34 s a row,
the app's own worker, constraints, cap and `preferVp8`):

| Row                                                                   | Verdict           | Video                                                                                                                                                                                            |
| --------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `video` (both cameras from the start)                                 | PASS              | VP8 640x480, 30 fps, 0 freezes, 3 key frames, 0 PLI, ~600 kb/s; worker frames sender 1090 / receiver 1080, decrypted 1080, failed 0; the remote picture's mean colour matches the sent one |
| `video-camera-late` (callee's camera added mid-call)                  | PASS              | 29.6 fps, 2 key frames, 1083 / 1083                                                                                                                                                                 |
| `video-switch`                                                        | PASS              | 29.9 fps, 1086 sender frames AFTER the switch, through the same transform                                                                                                                                  |
| `video-off-on`                                                        | PASS              | the peer's track mutes when off; events `unmute, mute, unmute`                                                                                                                                   |
| `video-whole-frame`, `video-h264`                                     | experiments       | the table above                                                                                                                                                                                  |
| `fault-video-bare-sender` (a camera on a REUSED offer-created sender) | fails, as it must | sender frames 0, decrypt-failed 1140, 105 PLI                                                                                                                                                    |

Audio stays clean on every row (match 0.96-0.98, LSD 3.92-4.02 dB on the gated rows, the `app` audio row unchanged at 3.92 dB).

**Owed on the phones** (a dev pre-release carrying this change; until then this is the rig only):

| Read                                                                                                               | Expected                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mi 9T to desktop Chrome, `bun callpeer.mjs --browser w3 --launch --dial --video --hangup` (and the phone dialling) | `video ... VP8`, ~30 fps, freezes 0, key frames a handful; the worker line's `video frames` growing both ways, `not-vp8=0`; `E2E proven`                                                                               |
| Mi 9T: off/on, switch front/back, minimise                                                                         | the desktop's picture mutes to the avatar and comes back; the back camera is not mirrored; the bar shows the thumbnail and the camera button                                                                           |
| Mi 9T: rotate                                                                                                      | the desktop's picture is `contain` in landscape, `cover` in portrait; the corner turns                                                                                                                                 |
| iPhone 12 (WKWebView)                                                                                              | `RTCRtpReceiver.getCapabilities('video')` lists VP8 and `setCodecPreferences` exists (else the camera stays off, said), frame metadata names `video/VP8` (a WebKit that names nothing FAILS CLOSED: whole frame, a `not-vp8` ERROR); orientation; the camera purpose string at the native revival |

**Notes, accepted as they stand:**

- **RTX on WebKit is unverified.** The preference list keeps VP8's RTX; whether WebKit pairs it and
  retransmits through the transform has not been read on the iPhone.
- **An old client cannot decrypt the new video** (a `<=1.3.1-alpha.4` dev build framed video whole).
  Those builds had `CALLS_VIDEO_ENABLED = false` and only dev builds call at all, so no shipped
  build is affected; audio between the two is unchanged.

## The quality ladder (2026-10-21) - 720p, and an automatic drop

**What was there.** A fixed 640x480 capture, the sender capped at 700 kb/s and 30 fps. libwebrtc
adapts INSIDE a ceiling (GCC lowers its target, VP8's quality scaler shrinks the picture on a high
QP), but nothing chose a larger picture on a good link, nor a smaller frame rate on a bad one. The
owner asked (2026-10-21, _"oui, lance"_) for 720p/30 at 1.5-2.5 Mb/s and a drop the way WhatsApp
and FaceTime do it.

**What it is** (`utils/callVideoQuality.ts`: the pure step, and `CallVideoQualityLoop`, the ONE
sample -> step -> apply loop that `CallService.startVideoQuality` AND the rig's page both run;
`utils/callVideo.ts` `applyCallVideoRung` applies a rung). The camera is asked for 1280x720 as an
IDEAL, never a `max` - both bench phones capture portrait (720x1280), and a landscape `max` can make
the engine refuse or fall to a smaller preset; the size captured is logged
(`[Call] camera captures WxH at F fps`). The SENDER's single encoding is set to one rung:

| Rung     | `scaleResolutionDownBy` | Picture (720p capture) | fps | `maxBitrate` | Needs (estimate) |
| -------- | ----------------------- | ---------------------- | --- | ------------ | ---------------- |
| `720p30` | 1                       | 1280x720               | 30  | 2.5 Mb/s     | 1.2 Mb/s         |
| `480p30` | 1.5                     | 853x480                | 30  | 1.2 Mb/s     | 600 kb/s         |
| `360p30` | 2                       | 640x360                | 30  | 700 kb/s     | 350 kb/s         |
| `360p15` | 2                       | 640x360                | 15  | 400 kb/s     | 180 kb/s         |
| `180p15` | 4                       | 320x180                | 15  | 200 kb/s     | -                |

A camera STARTS on `480p30`: libwebrtc's estimate starts near 300 kb/s and ramps, so a call opened
at 720p would read "bandwidth" in its first seconds and drop; a clean link climbs to 720p after
three clean samples. Every rung is the same capture scaled down by the sender, so a change never
reopens the camera and survives a switch or an off/on (the encodings belong to the sender).

**How it moves.** One `getStats()` every 2 s (`CALL_VIDEO_QUALITY_SAMPLE_MS`); each sample is read
against the previous one (`videoEvidence`): the loss the peer reports for the packets sent between
the two (`remote-inbound-rtp`), the round trip, the congestion controller's estimate
(`candidate-pair.availableOutgoingBitrate`), the encoder's `qualityLimitationReason`, and the share
of the interval the encoder spent encoding (delta `totalEncodeTime` / delta time).

- **Only a FRESH receiver report is evidence of loss or round trip.** The peer's RTCP report is
  cumulative and stays in `getStats` when reports stop coming (an outage, a peer that stalled): read
  naively it is "0 % loss" forever. A loss and a round trip are read only when `reportsReceived` (or,
  where an engine does not count them, the report's `timestamp`) moved since the previous sample;
  otherwise both are UNKNOWN, and unknown never counts as clean. The pair's round trip stands in only
  when the peer sends no report at all.
- **Bad** (`judgeVideoEvidence`): loss >= 10 %, round trip >= 800 ms, a CPU-starved encoder, or one
  limited by `bandwidth` while a KNOWN estimate is under the rung's need (a missing estimate is not
  bad). **Two consecutive bad samples drop**; a SEVERE one (loss >= 25 %, round trip >= 1.5 s, an
  estimate under half the need) drops at once. A bandwidth drop lands on the highest rung the
  estimate carries, not one rung down.
- **CPU is judged on the encoder's LOAD, not on its state.** `qualityLimitationReason=cpu` is a
  sticky state: libwebrtc keeps reporting it after a drop has relieved the encoder, and judged alone
  it walked a call from 720p to 180p one pair of samples at a time (review of #2173). So a sample is
  CPU-bad only when the state says `cpu` AND the encoder was busy half the interval or more
  (`CPU_ENCODE_SHARE_BAD`); a lingering `cpu` after a drop costs exactly one rung, a unit case.
  `qualityLimitationDurations` was rejected for the same reason: it accrues while the state HOLDS,
  so its delta says the state lingered, not that the encoder is still saturated.
- **Clean**: a FRESH loss < 3 %, a KNOWN round trip < 350 ms, an encoder that is not limited (a
  lingering `cpu` counts as not limited once the encoder is under 30 % busy, `CPU_ENCODE_SHARE_CLEAR`),
  and an estimate that is absent or either carries the rung above OR stands 1.3 times above the
  bitrate actually sent (`HEADROOM_CLIMB`). **Three consecutive clean samples climb ONE rung.** The headroom clause is
  measured, not argued: the rig's cheap synthetic scene sent ~670 kb/s at 480p, the estimate
  followed what was sent, and the call never reached 720p's 1.2 Mb/s need. A full link reads an
  estimate close to what is sent (ratio ~1), so it never qualifies on headroom.
- **A stale `bandwidth` does not pin a call.** After a camera switch (and an off/on), Chrome went on
  reporting `qualityLimitationReason=bandwidth` for the whole call at ~700 kb/s sent against a
  2.97 Mb/s estimate: libwebrtc's start-up adaptation, not the link (rig trace, 2026-10-21). So
  `bandwidth` blocks a climb only while the estimate does not show BOTH the rung above's need and
  headroom over what is sent; it still drops a rung whenever the estimate is under the current
  rung's need.
- **A failed probe doubles the price of the next one**: a drop within 15 samples (~30 s,
  `PROBE_WATCH`) of a climb doubles the clean samples needed to climb into that rung again (up to 48,
  ~96 s). The watch was five samples in the first draft, and a link that held 720p for ~16 s cycled
  every ~20 s at an unchanged price (review of #2173); a simulation test now runs that link for 300
  samples and asserts a handful of climbs, each further apart than the last.
- **A RELAYED call is capped at `480p30`** (`CALL_VIDEO_RELAY_TOP_RUNG`): when the selected pair's
  local or remote candidate is `relay`, the media crosses our TURN server, whose traffic is billed;
  a ladder above the cap is brought down at once (`cause: relay` on the line) and never climbs past
  it while the pair stays relayed.
- **Counted, never timed.** A camera that is off sends nothing and is no evidence: both streaks
  break and nothing moves, and the 2 s timer is NOT re-armed while the sender has no track - turning
  the camera back on resumes it from a new baseline. The sample read across a change is never judged
  (it mixes two encodings).
- **`degradationPreference` is left unset, deliberately.** Two controllers would then move the same
  picture: libwebrtc's own adaptation (inside the ceiling the rung sets) and this ladder (the
  ceiling). Setting `maintain-resolution` or `maintain-framerate` would change what libwebrtc does
  inside a rung and is a separate decision; the ladder's start line logs the value the sender
  carries (`degradationPreference=unset` expected), and reading VQ checks it on each phone.
- **Why the estimate alone never drops a rung.** A still scene encodes far under its ceiling, and
  libwebrtc's estimate seldom grows much past what is sent: a low estimate is then the SCENE. Only
  the encoder saying it had to shrink for want of bandwidth, or the peer reporting loss, or a round
  trip that says the path is queueing, is evidence about the link. The same fact sets the needs: each
  rung's need is at most the ceiling of the rung below, so a link that fills a ceiling qualifies for
  the next rung up.
- **Every change costs a key frame** (VP8 restarts on a new resolution) - one more reason the
  climb is slow and the probe price doubles.
- **The log** (`[Call]`): `video quality ladder starts on 480p30 (degradationPreference=unset)`
  once, then one line per change, naming its evidence -
  `video quality up 480p30 -> 720p30 after 3 clean samples (loss=0% rtt=40ms limit=none avail=2600kbps sent=900kbps enc=6%)`,
  `video quality down 720p30 -> 360p15 after a severe sample, the climb into 720p30 failed - the next one needs 6 clean samples (...)`;
  then `video sender on <rung> (...)`. Nothing per sample. A WARN, ONCE per ladder, if the peer sends
  no fresh loss figure for five samples (the ladder then holds and cannot climb); a WARN, once, if
  `getStats` fails; an ERROR and the ladder STOPS if the engine refuses `setParameters` - there is no
  other way to set a rung, so nothing else is tried. Refused at the START (before negotiation), the
  line is `video quality ladder not started: the sender refused 480p30`, and reading VQ looks for
  it. A refusal leaves the reduced-picture flag as the sender still is: the encodings did not change.
- **The screen** says _"Votre vidéo est envoyée en qualité réduite (connexion ou appareil saturé)"_
  under the status line while this side's camera is on and the ladder stands at `360p15` or below
  (`CallService.videoSendReduced`, `CALL_VIDEO_REDUCED_FROM_RUNG`). It speaks of THIS side's
  picture only: the peer's ladder is the peer's.
- **E2E unchanged.** VP8 only, the 10-byte key-frame / 3-byte interframe clear header bound as AAD:
  the header layout does not depend on the size (a VP8 key frame carries a 14-bit width and height,
  1280x720 fits), and the worker encrypts any length - a 720p key frame is only a larger
  ciphertext. The `video` rig row decrypts every frame at 720p with 0 failures.

**Measured in the rig, 2026-10-21** (Chrome 155 to Chrome 155 on the bench desktop, Chrome's fake
camera at 30 fps - a synthetic pattern that compresses far better than a face, so the BITRATES are
low and only the shape and the encode cost carry over; 34 s a row; `encode ms/frame` is libwebrtc's
`totalEncodeTime / framesEncoded`, the encoder's wall time, which can understate CPU when libvpx
threads):

| Row                       | Verdict           | Sent (ladder)                          | Decoded             | Key frames | Encode ms/frame (% of a core)                          |
| ------------------------- | ----------------- | -------------------------------------- | ------------------- | ---------- | ------------------------------------------------------ |
| `video`                   | PASS              | 1280x720, 914 kb/s (480p30 -> 720p30)  | 29.8 fps, 0 freezes | 5          | 1.71 (5.1)                                             |
| `video-camera-late`       | PASS              | 1280x720, 885 kb/s (480p30 -> 720p30)  | 28.7 fps, 0 freezes | 3          | 10.46 (30.0) - host noise, 1.43-1.48 in two other runs |
| `video-switch`            | PASS              | 1280x720, 1031 kb/s (480p30 -> 720p30) | 29.8 fps, 0 freezes | 3          | 3.26 (9.7)                                             |
| `video-off-on`            | PASS              | 1280x720, 985 kb/s (480p30 -> 720p30)  | 29.8 fps, 0 freezes | 3          | 1.89 (5.7)                                             |
| `video-rung-720p` (held)  | experiment        | 1280x720, 977 kb/s                     | 29.9 fps            | 4          | 1.58 (4.7); 1.71 in run 1                              |
| `video-rung-480p` (held)  | experiment        | 853x480, 610 kb/s                      | 29.9 fps            | 4          | 1.17 (3.5); 1.74 in run 1                              |
| `video-rung-360p` (held)  | experiment        | 640x360, 476 kb/s                      | 30 fps              | 3          | 0.96 (2.9); 1.03 in run 1                              |
| `video-whole-frame`       | experiment        | 1280x720                               | 29.9 fps            | **537**    | -                                                      |
| `fault-video-bare-sender` | fails, as it must | -                                      | 0 frames, 112 PLI   | 0          | -                                                      |

Every row decrypts every frame it receives (decrypt-failed 0 on the gated rows); audio unchanged
(match 0.97-0.98, LSD 3.92-3.95 dB). **Read of the cost:** on a desktop CPU, 720p costs ~1.3-1.5x
the encode time of 480p and stays near 5 % of one core; the run-to-run spread (two Chromes encoding
on one host) is as large as the difference between rungs, so the rig says "no cliff", not a number
to carry to a phone. **The phone cost is owed** (below): libvpx is software on the iPhone, and the
Mi 9T may or may not get a hardware VP8 encoder in its WebView (`enc=` on the log line says which).
**Two things the first run found, both fixed before this table:** the switch and off/on rows never
climbed (the headroom clause and the stale-`bandwidth` clause above), and the `video` row's key
frames reached the old bound of 5, since each rung change costs one: `video-keyframes` is now 8, still
two orders of magnitude under the 537 of a header that is not readable.
**Re-run after the review fixes (2026-10-21, same rows):** the ladder's shape held on every row -
each climbed `480p30 -> 720p30` once, key frames 3-5, decrypt-failed 0 - but the host sat at 100 %
CPU from parallel jobs (measured with no rig running), and `video-switch` / `video-off-on` fell
under the 27 fps bound together with the HELD `video-rung-480p` control, which runs no ladder at all,
and an audio concealment bound. That is the host, not the change; the table above is the quiet-host
run.

**What the rig cannot show.** The DROP: the rig impairs at the receiver TRANSFORM (frames), not on
the wire, so libwebrtc's congestion controller and the peer's loss report never see it. The downward
path is proven by the unit tests (`callVideoQuality.test.ts`: every threshold, the streaks, the
severe drop, the probe price, the cap) and by the service tests on fake stats
(`CallService.p2p.test.ts`, "the quality ladder") - and it is owed on the phones, below.

### Measuring it on the phones (owed: device-verification VQ)

The reading agent runs this on both bench phones against a desktop Chrome
(`bun tools/cross-client-harness/callpeer.mjs --browser w3 --launch --dial --video --seconds 300 --hangup`),
records the numbers in [device-readings-2026-10](../../device-readings-2026-10.md), and the verdict
in [device-verification VQ](../../device-verification.md#vq-call-video-at-720p-and-its-quality-ladder---owed-on-both-phones-mi-9t-iphone-12).

1. **The climb.** Good Wi-Fi, phone screen on, the call screen up. First record three lines: the
   size the camera really captures (`[Call] camera captures WxH at F fps (user)` - 720x1280 or
   1280x720 expected; anything smaller means the constraints did not reach 720p), the
   `video quality ladder starts on 480p30 (degradationPreference=unset)` line (any other value means
   a second controller is set), and the ABSENCE of `video quality ladder not started`. Expect `video quality up 480p30 -> 720p30`
   within ~10 s of `connected`, then `callpeer`'s received picture at 1280x720 (or 720x1280), ~30 fps,
   freezes 0. Each conclusive path check logs `video ... send=... enc=<encoder> encode_ms=<mean>`:
   record `enc` (software `libvpx`, or a hardware encoder) on each phone.
2. **The cost, per rung, 5 minutes each, the same scene** (the phone propped, the front camera on a
   face or a busy room, never a blank wall). Four runs per phone: an AUDIO call (the baseline), a
   video call at 720p, at 480p, at 360p. Read every 10 s:
   - **Mi 9T** (adb): `adb shell top -b -n 1 -m 15` - the app process AND the WebView renderer
     (`com.google.android.webview:sandboxed_process*`), where WebRTC encodes; `adb shell dumpsys
     thermalservice` (the throttling status and the skin / CPU temperatures); `adb shell dumpsys battery`
     (`temperature` in tenths of a degree, `level`).
   - **iPhone 12** (no adb): the app's own `encode_ms` and `limit=` lines from the in-app log, and the
     process CPU from `pymobiledevice3 developer dvt sysmon process single` (filter the Canari process
     AND `com.apple.WebKit.GPU` / `com.apple.WebKit.WebContent`, where WebKit runs WebRTC - read
     `--help` first, the flags move between versions) and the battery temperature from
     `pymobiledevice3 diagnostics battery single` (`Temperature`, hundredths of a degree). The thermal
     STATE is not readable from outside; a "the iPhone is hot" banner or the screen dimming is
     recorded as seen.
   - **Holding a rung**: the ladder holds 720p on a clean link by itself. For 480p and 360p, throttle
     the PHONE's uplink so the ladder settles there (step 3): ~1 Mb/s holds `480p30`, ~500 kb/s holds
     `360p30`. On the Mi 9T, a rung can also be held over CDP (dev builds are inspectable): track
     the page's peer connections as `callpeer.mjs` does, then `setParameters` on the video sender
     with that rung's values - the ladder re-applies only on a CHANGE, and a clean link at the top
     makes none.
   - **The verdict per rung**: CPU (% of the app's processes), the temperature after 5 minutes, the
     battery % spent, and whether `limit=cpu` or a `video quality down ... limit=cpu` line appeared.
     720p is acceptable on a phone if it holds 30 fps with no `cpu` limit for 5 minutes and its
     temperature rise stays within a few degrees of the 480p run; otherwise the reading says so and
     the start rung or the top rung is revisited (a constant here, not a redesign).
3. **The drop and the return.** Throttle the phone during a call:
   - **iPhone**: Settings > Developer > Network Link Conditioner (present while the developer image
     is mounted, as it is for WebDriverAgent): "3G", then "Very Bad Network", then a custom profile
     (uplink 500 kb/s, 5 % loss, 300 ms delay).
   - **Mi 9T**: Wi-Fi through the bench PC's mobile hotspot, shaped there (Windows `clumsy`: drop
     10 % / lag 400 ms; a bandwidth cap if the shaper has one).
   - Expect a `video quality down` line within ~4 s (two 2 s samples, or one severe), naming its
     evidence; the reduced-picture notice at `360p15` and below; no freeze longer than the drop
     itself (`callpeer`'s `freezes`). Lift the throttle: one rung climbed per ~8 s, and a climb that
     fails at once doubles the next one's price (the line says so).

## The call UI: the whole screen, or a bar at the top (2026-10-19)

**The user's verdict** (2026-10-19): *"l'UI de l'appel telephonique (surtout audio seul) est nulle,
inadaptee sur mobile ... Sur un Messenger, soit ca fait toute l'interface, soit ca fait un bandeau
en haut, pas cette espece de modal qui en plus est sur ou sous le reste de l'interface."* And from
the iPhone the same day (CALL-IOS-HANGUP, P1): the docked card's mute, speaker and hang-up sat UNDER
the native glass tab bar - the red glyph visible through the glass, no tap reaching it - so the call
could only be ended from the other phone. A native view is drawn above the whole WebView, so no
z-index can lift a web control over it.

**Two shapes, one flag** (`stores/callView.svelte.ts`, `minimised`):

| Shape | Component | Where it lives | Why it cannot be covered |
|---|---|---|---|
| Full screen: avatar, name, status/timer, 64px controls under the thumb (mute, speaker on the apps, hang-up; decline/accept when ringing), the E2E line, a chevron to minimise | `chat/CallOverlay.svelte` | portalled to the body, `fixed inset-0`, `--z-call`, safe-area padding on all four sides | it joins `coversScreen`, which HIDES the native tab bar and the native glass pieces; `--z-call` is above every sheet, modal, toast and confirmation |
| A slim bar: "Bob · 02:13", a tap returns to the full screen, mute and hang-up on the bar (decline/accept when ringing) | `layout/CallBanner.svelte` | a ROW of the root layout's banner column, in flow, under the status bar | it pushes the page down rather than covering it (the column publishes `--app-banner-height`), and nothing native is drawn above the content's top edge - the glass pieces follow their web twins down |

Every call opens full screen (an incoming ring too, on every route: the compact incoming toast and
its `--z-call-notice` rung are gone). **The system Back, Escape, the chevron and the bar's expand
all MINIMISE through ONE path** - the binder's `dismissFromUi()` (`bindHistoryOverlay`), so a
minimise from the UI leaves a ghost entry the next expand REUSES; a direct `callView.minimise()`
from a button would leave the history stack one entry deeper per cycle (the review of #2138 found it;
`CallOverlay.svelte.test.ts` counts the depth and `history.length` over two cycles). No gesture ends
a call. Measured in Chromium at 390x844 (touch) and 1280x800, on `/legal/privacy`
with a stand-in `CallService` (no local estate, no account): the bar is 52px at the top of the
content under the environment banner, the page starts below it, and `elementFromPoint` at the
centre of each of its three controls lands on that control (44x44 each on touch). A conversation
was NOT rendered under the bar (no signed-in account here) - `ChatArea`'s header is in flow inside
`main`, so it is pushed like any page; **owed: one look on each phone with a conversation open.**

**Who is on the other end** is read from the CALL's conversation (`utils/chat/callPeers.ts`,
`CallService.currentGroupId`), never from the one on screen: once the app can be browsed under the
bar, `currentConvo` is whatever was opened last, and the old overlay would have renamed the call
after it.

**What the surfaces say** is one `CallStatusKind` (`callStatusKind`): `ringing`, `incoming`,
`connecting` (the callee is `incall` from the tap, seconds before any sound), `live` (the timer),
`reconnecting` ("Reconnexion...", `CallService.reconnecting` - the ONE flag the CALL-WIFI resume
writes from signalling lost, peer away and ICE state; the UI only reads it, and only once `connectedAt`
is set), `ended` ("Appel termine ·
02:13").

### Which layer the call is on, and what it may never cover

**The full screen has its own rung, `--z-call` (330), ABOVE `--z-critical` (320, a confirmation).**
A call that rings while a "sign out?" or "delete?" confirmation is open must still be answerable;
the confirmation is not lost - minimise the call and it is there, unchanged. Sharing 320 with
`ModalOverlay` would have left the winner to DOM order, which is exactly the "on or under the rest"
the user reported.

**The PIN lock is never covered, and it is not by a z-index.** `PinModal` sits at `--z-modal` (280),
below the call - so while it is up (`ChatBackgroundService` -> `callView.setLocked(showPinModal)`)
the full screen STEPS BACK and the call is the top bar, which is in flow and covers nothing; it comes
back when the PIN is entered. A ring on a locked app is still answerable from the bar - the device is
not unlocked by it, and the conversation behind stays sealed.

### The bar is never under a layer (CALL-BAR-COVERED, 2026-10-19)

**Read on both phones (`1.3.0-alpha.2`):** with the new-post composer (a modal, 280) or its camera
(a viewer, 300) open, the bar - a row of the banner column at `--z-banner` (120) - was under that
layer, `elementFromPoint` at its hang-up returned the camera's video, and the call could not be
ended until the layer closed.

**THE RULE: while a call bar is up, nothing that covers the screen covers the bar.** `CallBanner`
sets `data-call-bar` on the root, and `app.css` then:

1. lifts the banner column (`.app-banner-column`) to `--z-call` - above every sheet, modal, viewer
   and confirmation (the full screen, which also takes `--z-call`, is never up at the same time);
2. pushes every covering surface's top inset below the column: the `coversScreen` action marks its
   node `data-covers-screen`, and on such a node `--safe-area-inset-top` reads `--app-cover-top`
   (status bar + `--app-banner-height`, resolved on the root). The surface still fills the screen
   behind the bar; its OWN top controls (the camera's close, a phone-full modal's title) move below
   it, as under a phone's in-call status bar. Every top control reads `--safe-area-inset-top`, never
   `env()`, which is what makes one variable enough;
3. gives the camera TAB (`fullscreen-place-open`, which runs under the status bar) its top padding
   back, or the bar would sit under the notch.

So a NEW covering surface is covered by the rule if it uses `coversScreen` and a rung below
`--z-call`. `styles/callBarLayer.test.ts` fails on a covering file naming a rung at or above
`--z-call`, on a component reading `env(safe-area-inset-top)`, and on any of the three rules gone.
Measured in Chromium at 390x844 (touch) and 1280x800 with a stand-in `CallService` and a stand-in
viewer-rung layer marked `data-covers-screen`: `elementFromPoint` at the centre of each of the bar's
three controls lands on that control, and the layer's top control moves from y = 12 to y = 64 (the
52px bar + its own 12px). With `data-call-bar` removed, the same probe on hang-up lands on the layer.
**Owed: one look on each phone** with the composer and the camera open during a call.

**The OS banner on top of the ring (CALL-OS-BANNER, iPhone, same reading).** In the foreground the
ring is already the whole screen, and an "Appel entrant" OS notification was drawn over it. The local
notification (`useNotifications.notifyIncomingCall`) is now DEFERRED while the page is visible:
posted if the app leaves the screen while the call still rings, dropped when the ring ends; logged
`[NOTIF] incoming call in <group> rings in-app - no OS notification while the app is on screen`.
If a banner still shows in the foreground on the next reading, it is not this path - see
[backlog](../../backlog.md#p3---an-os-incoming-call-banner-over-the-in-app-ring-if-it-outlives-the-web-fix-2026-10-19).

### One call screen on every platform (2026-10-23)

**The request** (user): *"la parite, au moins en apparence, sur toutes les plateformes pour les appels. Un affichage plein ecran avec le nom, la photo et les boutons pour decrocher/decliner ... comme une application d'appel (Messenger, WhatsApp)."*

**The audit found the structure already there** (`CallOverlay` is full screen with safe-area padding, name, avatar, decline/accept, mute, hang-up, timer, on web and in both apps, because the apps embed the same frontend). What was missing was the LOOK, and the three surfaces speaking one language:

| Moment | In-app screen (web, Android, iPhone) | Android native ring (CallStyle + full-screen intent) | iPhone native ring |
|---|---|---|---|
| Incoming | name, photo, "Appel audio" / "Appel vidéo" ([2026-11-01](#the-incoming-call-screen-in-canaris-look-owner-2026-11-01)), **Refuser (red, left) - Accepter (green, right)** | the system CallStyle: Decline left, Answer right; on a locked phone `IncomingCallActivity`, the same screen as in-app | generic alert until the native ring (another work package) ships; CallKit's own screen, once it does, is decline left, accept right |
| Outgoing | name, photo, **"Appel..." / "Calling..."** (was "Sonnerie..." / "Ringing..."), mute, hang-up | - | - |
| In call | name, photo, `mm:ss`, mute, camera, speaker (apps only), hang-up | the ongoing CallStyle with the same "Calling..." text while dialling (it reads the same `call_ringing_label`) | - |

What changed: the other person's photo, blown up, blurred and dimmed, is the backdrop of an audio screen (the SAME `Avatar` component, so one cache and one fallback; with no photo it is the dark initials tile; hidden from assistive tech; absent over a video picture). The avatar is larger (128 px, 176 px from `md`), the name is `text-3xl`, and the accept and decline buttons take two tokens, `--color-call-accept` and `--color-call-decline`, fixed in both themes like `cn-scrim`. An incoming ring after a notification tap is the same screen: every call opens full screen, on any route. Calls are 1:1 (a group has no call), so there is no group screen to draw. No control depends on the keyboard, and `motion-safe` gates the ringing halo.

`CallOverlay.svelte.test.ts` ("the screen every platform shows") pins the name, the backdrop, decline-before-accept DOM order, the tokens, "Calling..." and the absence of Accept on an outgoing call.

**Rendered in Chromium** with a stand-in `CallService` on a public route (no estate, no account, so the photo is the initials tile): [incoming at 390x844](assets/call-screen-incoming-390.png), [in call at 390x844](assets/call-screen-live-390.png), [calling at 1280x800](assets/call-screen-calling-1280.png) (the desktop screen is the whole window, as on Messenger web). **Owed to a phone:** a REAL photo behind the blur on the Mi 9T and the iPhone (WebKit's `blur-3xl` on a scaled element is the cost to read), the safe-area on the notch, and the Android speaker button in the screenshot's place.

### The incoming-call screen, in Canari's look (owner, 2026-11-01)

**The request** (owner): *"L'ecran quand on nous appelle est assez moche, avec juste deux gros carres vert et rouge. Refais tout : quelque chose de joli avec ecrit Appel video ou Appel audio, la photo et le nom, dans la belle identite visuelle de Canari."* The squares were Android's locked-phone screen (`IncomingCallActivity`: two flat `Button`s with `setBackgroundColor`); the in-app ring already had round buttons but said only "Appel entrant". Both now draw ONE screen, top to bottom:

| Piece | In-app (`CallOverlay.svelte`, `isIncoming`) | Android locked phone (`IncomingCallActivity.drawScreen`) |
|---|---|---|
| Backdrop | Canari's night gradient `from-cn-ink to-cn-scrim`, the caller's photo blurred over it (as before), a veil, and a `cn-yellow/15` glow behind the face (ring only) | the same gradient (`call_screen_top/bottom`), the ORIGINAL photo blurred by `RenderEffect` (API 31+; the gradient alone below), the same veil and radial yellow glow. The photo is `callScreenPhoto`: the cached avatar FILE decoded uncropped and sampled to the screen's short edge, off the main thread - never the notification icon, which is circle-cropped at icon size and would blur into a disc with transparent corners and upscale the face. With no readable original the icon is the face and there is no backdrop |
| Photo | 144 px (192 from `md`), a `cn-yellow/60` ring, initials tile until/without a photo | 144dp, the same yellow ring, initials (`initialsOf`) until the photo; the Canari mark for a caller this phone never named |
| Halo | two `cn-yellow` halos, `animate-call-halo` and `animate-call-halo-late` (2.4 s, scale 1 -> 1.45, fade; the second 1.2 s behind), `motion-safe` only | the same two halos (`HALO_MS`, `HALO_SCALE`), skipped when the phone's animations are off (`ValueAnimator.areAnimatorsEnabled`) |
| Name, kind | `text-3xl` name, then a pill: `Phone` + "Appel audio" or `Video` + "Appel vidéo" (`call_audio_only_label`, `chat_video_call_label`) | 32sp name, the same pill (`call_screen_kind_audio` / `_video`, app locale) |
| Actions | Refuser (red, `PhoneOff`) left, Accepter (green, `Phone`, or `Video` for a video call) right, 64 px discs, labels under, a coloured shadow | the same order and colours (`call_decline`, `call_accept`), 72dp discs with a ripple, Material glyphs (`ic_call_decline`, `ic_call_answer`, `ic_call_answer_video`), labels under, above the navigation bar's inset |

The Android colours - the white inks over the screen included (`call_on_screen*`, `call_pill_*`, `call_ripple`) - are `res/values/colors.xml` entries that name their `app.css` twin; the screen is dark in both themes, like `cn-scrim`, so they have no night variant. The ring's `call-status` line is gone (the kind pill replaces it, and the live region still announces "Appel entrant"), so `call_incoming_video_label` was deleted; `IncomingCallActivity.intentFor` now takes `hasVideo` instead of the notification's body text. The CallStyle notification itself is the system's and was not touched; the iPhone's lock screen is CallKit's and cannot be drawn.

`CallOverlay.svelte.test.ts` ("the incoming-call screen") pins the audio and video subtitles and glyphs, the name after the photo, the initials fallback, the halo and glow on a ring only, and that Accept and Decline call `acceptCall` and `endCall`. **Rendered in Chromium** at 390x844 with a stand-in `CallService` (no account, so the initials tile): [audio](assets/call-screen-incoming-390.png), [video](assets/call-screen-incoming-video-390.png); light and dark render the same, by design. **Owed to a phone:** the locked-phone ring on the Mi 9T (photo, blur, halo, both buttons, the gesture-bar inset, a caller never named), and the in-app ring on the iPhone 12 (a real photo behind the blur, the halo's cost in WebKit, the notch).

### Ringing, announcing, hearing

- **The ring is an `alertdialog` with focus on Accept** (`preventScroll`); once answered it is a
  plain `dialog`. ONE `role="status"` region, outside the full screen so it survives a minimise,
  announces each state change - "Appel connecte" rather than the timer, which would speak every second.
- **A refused voice says so.** A WebView may refuse `play()` without a gesture (`NotAllowedError`);
  the voice usually arrives seconds after the last tap. `utils/callVoice.ts` tells that refusal from
  any other failure, the screen and the bar say "Toucher pour entendre", and the NEXT pointer event
  anywhere (or the Accept tap, which primes the sink) starts it. Logged: `[Call] WARN voice refused
  without a gesture (<why>) - waiting for a tap`.
- **A second call while one is up is answered BUSY** (a typed frame, never a hangup, which would reach
  the whole conversation); see [the call record](#the-call-record-one-writer-a-typed-reason-2026-10-27).
  Logged: `[Call] invite <callId> in <groupId> meets state=... call=...`
  (`CallService.p2p.test.ts`, "a second call while one is up").
- **The 64px controls are size-checked on the RENDERED screen**, not by `iconButtonScale.test.ts`:
  they are drawn by a snippet that markup scan cannot see through. `CallOverlay.svelte.test.ts`
  holds every button of the ring and of the call to `ui-icon-button` or `size-16`; the bar's buttons
  are plain markup and stay under the scan.

### The caller's ringback (2026-10-31)

**Before it, the caller heard nothing** between the dial tap and the answer: the screen said
"Appel..." and no sound said the other phone rang (read in `CallService` and `CallOverlay`: no
element, no tone on the `calling` side). The owner asked for one *"mieux qu'une tonalite de
telephone, dans le style d'un canari qui chante"*.

- **The sound.** `RINGBACK_PHRASE` in [soundPalette.ts](../../../../frontend/src/lib/utils/soundPalette.ts):
  a soft roll of six quick rising syllables (1350 -> 1810 Hz) and two slower falling whistles
  (2150 -> 1600 Hz, a faint octave partial), below the notification trills so it never gets shrill
  over a minute of ringing. Rendered by `bun tools/notification-sounds/render.mjs` into
  `frontend/static/sounds/canari_ringback.wav`: ONE loop of exactly `RINGBACK_PERIOD_S` = 4 s (the
  phrase, its small room, then silence - 1.2 s of phrase, its room fading under it, then about 2 s of
pause, a phone's rhythm),
  loudest peak -14 dBFS, 11 dB under the notifications. `--check` covers it like the three channel
  sounds (`notificationSoundsDrift.test.ts`).
- **What drives it: state, not a timer.** `CallService.ringingOut` is written by `syncRingingOut(why)`
  from three facts - the caller's ring window is open (set in `armRingTimer('calling')`, i.e. once
  the invite has left), nobody answered (`peerArrived`), and the state is still `calling`. It moves
  at the invite, at `PeerReady` (answered), at `endCall` (declined, busy, cancelled, not answered,
  setup failed - the outcome is the reason) and at any state change (the backstop). Each move is
  logged: `[Call] ringback starts - the invite left (call=...)`, `[Call] ringback stops - the call
  ends (outcome=declined) (call=...)`. Never `true` on the callee: only the caller opens that window.
- **What plays it.** `CallOverlay` mounts a second hidden `<audio>` beside the voice sink and hands it
  to [callRingback.ts](../../../../frontend/src/lib/utils/callRingback.ts): `start` / `stop` follow
  `ringingOut`; the element's own `loop` repeats the file. `prime` - a muted play paused at once -
  runs inside the dialling tap (the overlay mounts within it) - NOT on Android, whose WebView plays
  without a gesture and where a muted play before the microphone is held would open a MEDIA-usage
  stream on the loudspeaker - so the `play()` seconds later is not
  refused by a WebView's gesture rule; a refusal still says `[Call] WARN ringback refused without a
  gesture`. Logged: `ringback primed`, `ringback playing (...)`, `ringback stopped (...)`.
- **The output.** The microphone is held BEFORE the invite (`setupMedia`), so on Android the
  ongoing-call service already holds the call's communication route when the ringback starts, and
  the WebView plays in communication mode: earpiece, or the speaker / headset the route says. On the
  iPhone the ringback element takes the same label-matched `setSinkId` as the voice. It is an output
  only: never added to a peer connection, and it stops at the pairing, before any media can flow.
- **Pinned by** `CallService.p2p.test.ts` ("the caller's ringback and the app's sound gate": start at
  the invite; stop on answer, decline, busy, cancel, setup failure, window closed; never on the
  callee) and `callRingback.test.ts` (loop, start, stop, a stop racing a pending `play()`, prime).
- **Owed on the bench phones:** heard on the Mi 9T and the iPhone 12 placing a call: (1) it starts
  within a second of "Appel...", (2) it comes out of the EARPIECE at a comfortable level and moves to
  the loudspeaker with the speaker button, (3) it stops the instant the other side answers or
  declines, (4) `adb shell dumpsys audio` during the ring shows the ringback's track with usage
  `VOICE_COMMUNICATION` (if it reads `MEDIA`, it is on the media volume through the speaker, and the
  route must be applied to it natively), (5) the callee hears nothing of it.

### The app's other sounds during a call (2026-10-31)

**Read on a production call** (owner's log): a native banner sounded for a message during an outgoing
ring; a message landing in the open conversation trilled while a call rang; a read trill played in
the call's own conversation. **Rule: from the ring (out or in) to the end, the app plays nothing but
the call. Messages still arrive and are shown; only their sound goes.**

| Sound | How it is silenced during a call |
|---|---|
| Message / mention / send / read trills (`useMessaging` arrival, `ChatBackgroundService` read watermark, `onReadStateAdvanced`) | `toneOutput.playTone` asks [callSoundGate.ts](../../../../frontend/src/lib/utils/callSoundGate.ts) and plays nothing. Each is counted (one `Log.d` line per tone, which the in-app log does not record); the count is told once on the gate's release line, `[AUDIO] the call released the app's sound (...) - N tone(s) silenced during the call`. The incoming ring passes `purpose: 'call'` and is exempt |
| Voice notes, audio attachments, videos, reels, lives, the reel review | `playbackArbiter`: a media playing WITH sound is paused when the gate is taken, and one that starts with sound during the call is paused on its `play`. Muted ones (the ambient feed) play on, until unmuted (`volumechange` pauses them). Nothing resumes on the call's end - the reader presses play. The reel review is now registered, so it also follows "one media at a time" and the pause on leaving the screen |
| Browser notification (web, desktop browser) | raised with `silent: true` |
| Android message, mention, reaction notifications (FCM push AND the WebSocket path, one builder) and social / form notifications | posted `setSilent(true)` - shown, not dropped - while [CallSoundHold](../../../../frontend/src-tauri/gen/android/app/src/main/java/fr/emse/canari/push/CallSoundHold.kt) holds: `CallForegroundService.running` (the caller from the held microphone on, the callee from the answer) or a native ring up (`activeCallRings`). Both are state of the process, dead with it. Logged `a call holds the sound -> posted silent` |
| iOS banners drawn by the notification service extension | `content.sound = nil` while `CXCallObserver` lists a call not ended (the CallKit ring, a call answered on it, a cellular call). In the foreground the app already presents no banner at all |

**The one gate.** Each `CallService` states its `callState` under its holder id; the gate is held while
any holder is `calling`, `incoming` or `incall` and released at `ended` / `idle`, or when a replaced
service is retired (`retireFromPageRing`). Logged once per change, through `Log.i` (`Log.d` writes
`console.debug`, which the in-app log never records - the line was unreadable on a device until
2026-11-01): `[AUDIO] a call holds the app's sound (...)` / `the call released the app's sound (...)`. Pinned by `callSoundGate.test.ts`,
`toneOutput.test.ts`, `playbackArbiter.test.ts`, the p2p block above and `CallSoundHoldTest.kt`.

**What is NOT covered, and what would lift it:**
- **Android, an in-app incoming ring before the answer.** The page rings (`incoming`), no foreground
  service runs yet and no native ring is up, so a native banner in those seconds still sounds. The
  JS tones are gated. Lifted by exposing `page_ring.rs`'s ringing fact over JNI (it already knows
  the page rings a call) and adding it to `CallSoundHold.held`.
- **iOS, a call CallKit does not know** (every outgoing call, an in-app ring, a call after the
  handover ended its CallKit session): the extension cannot see it. Lifted by CallKit for every call
  (owed, [the call in the background](#the-call-in-the-background-2026-10-19)); an app-group flag was
  refused because a crash mid-call would leave every later banner silent.
- **Desktop Tauri** notifications (`notify-rust`): unmeasured, not gated.

**Owed on the bench phones:** during a Mi 9T call (ringing out, then live) a message from a third
account arrives shown and SILENT (`dumpsys notification` shows it; no sound), and a voice note or a
reel cannot play aloud; on the iPhone 12, a message arriving during a CallKit-answered call is
delivered without sound (`[CanariNSE] a call is up - delivered without sound`).

## The call in the background (2026-10-19)

**The timer is a function of timestamps**: `CallService.connectedAt` (first `connected`, not the
tap) and `endedAt`, read by `utils/callClock.ts`; the 1 s interval and a `visibilitychange` only
REPAINT it. A throttled or frozen page is right on its first frame back.

**One audio sink for the whole call.** It used to live in each of the old overlay's two views, so
minimising destroyed the element playing the voice and built another. `CallOverlay` is mounted for
the whole call and holds the only `<audio>`; every `<video>` is muted.

**What the web can and cannot do** (what each engine does is unmeasured; the native half is a
backlog item, [P1 - a call does not survive the app leaving the screen](../../backlog.d/p1-blocks-production-calls-mode-a-call-does-not-survive-the-app-leavin.md)):

| Concern | Web (done) | Native (owed) |
|---|---|---|
| The OS knows a call is up | Media Session: title = the peer, `hangup` / `togglemicrophone` handlers, `setMicrophoneActive` (Chromium) - `utils/callMediaSession.ts`, each action in its own `try`, each refusal logged | Android: BUILT, [below](#wp-c-bg-a---the-android-ongoing-call-service-2026-10-20) (a `microphone` foreground service, not `phoneCall`); iOS CallKit for EVERY call (owed) |
| The microphone in the background | nothing can hold it: Android 9+ gives a backgrounded app silence; WKWebView stops capture when hidden | Android: the foreground service (BUILT); iOS: an `AVAudioSession` call session (owed) |
| Audio route (speaker, earpiece, Bluetooth) | iOS only: the loudspeaker by label-matched `setSinkId`, best effort, `WARN` when none is listed; the earpiece is the call's DEFAULT output (WebKit lists no such device), asked as `setSinkId('')` or nothing at all (`callAudioRoute.ts`) | Android: `AudioManager.setCommunicationDevice` in the service (BUILT); iOS: `AVAudioSession` (owed) |
| Screen wake lock | **deliberately none for audio**: a phone call lets the screen go dark in the pocket; a lock would light it. **A video call holds one** while either picture is on screen (`ScreenWakeLock` of `live/liveDevice.ts`, tag `CALL-WAKE`), taken again on every return to the foreground | - |
| Diagnosis | `[Call] app hidden` / `visible`, with `state=`, `mic=live/os-muted` and `voice=playing` or `paused`, `the system took the microphone`, `the voice was paused while hidden - starting it again` | - |
| The partner is told | `MicSuspended { suspended }` over the relay, sent by the side whose OS took its microphone; a notice on both screens and in the live region, a toast on the way back ([below](#wp-c-bg-i---the-iphones-microphone-in-the-background-2026-10-20)) | - |

**Read on both phones since** ([device readings](../../device-readings-2026-10.md)): the Mi 9T loses its
call socket and all audio 5 s into a lock (CALL-LOCK-ANDROID, WP-C-BG-A); the iPhone keeps the call
and loses only its microphone - next section.

## WP-C-BG-I - the iPhone's microphone in the background (2026-10-20)

**What was measured first** (`v1.3.1-alpha.4`, TestFlight build 100300104, iPhone 12 on iOS 27.0.1,
Mi 9T caller, same Wi-Fi; the Mi 9T's `getStats()` every 5 s over CDP, the iPhone's app state through
WDA every 15 s). The iPhone was locked by WDA for 3 min 20 s mid-call:

| Observable | During the lock |
| --- | --- |
| The iPhone's process | the SAME pid before and after, WDA app state `3` (running in the background) at every poll, never `2` (suspended) |
| The iPhone's WebRTC stack | ALIVE: its RTCP receiver reports kept reaching the Mi 9T (`remote-inbound-rtp` round-trip measurements 4 -> 39, the iPhone's `remote-outbound-rtp` reports 3 -> 42), so it was receiving the Mi 9T's audio and answering for it |
| The iPhone's microphone | GONE within 3 s: the Mi 9T's inbound audio packets froze at 1020 and did not move for the whole lock (its concealed samples climbing by 240 000 every 5 s) |
| On unlock | packets again within 10 s (1020 -> 1614), audio level back |

That is the alpha.3 reading (`WARN the system took the microphone (track muted)`) with its cause
separated: **nothing is suspended, CallKit or not; only the capture is muted.** WKWebView mutes a
page's microphone when the app is hidden **unless `UIBackgroundModes` contains `audio`** - stated by
WebKit's media-capture maintainer ([WebKit bug 226620](https://bugs.webkit.org/show_bug.cgi?id=226620),
comment 3) and reported fixed by exactly that on iOS 17.5
([Apple forums 689182](https://developer.apple.com/forums/thread/689182)). WebKit configures the audio
session itself while it captures (`playAndRecord`), so no native `AVAudioSession` code is written:
none was shown to be missing.

**What was built:**

- **The `audio` mode**, first patched into every PRE-RELEASE iPhone build by `ios.yml`, and **in the
  committed `Info.plist` since the flip (2026-10-22)**: the patch is deleted. A mode declared and
  unused is what App Review refused once (2.5.4), so `callsCompiled.test.ts` asserts the committed
  mode follows `CALLS_COMPILED` and that no build step writes it.
- **CallKit is NOT the fix for this.** The process was never suspended, so a CallKit report would buy
  nothing the measurement shows missing; reporting every call to CallKit stays with the `voip` revival
  (it is mandatory for a VoIP push, which the in-app call does not use).
- **The partner is told, whatever the cause** (Siri, another app's call, a build without the mode):
  `CallService.watchSystemMicrophone` listens to the capture track's `mute` / `unmute` (moved there
  from `CallOverlay`, which only logged them) and sends `MicSuspended { suspended }` over the relay;
  only the sender knows, and silence, a lost path and a quiet room look the same from the other end.
  The partner's full screen, its top bar and the live region read *"Le téléphone de X a coupé son
  micro"* while it lasts; the local screen reads *"Votre téléphone a coupé votre micro"*, and because
  that screen was hidden while it lasted, a toast says for how long on the way back
  (`call_mic_was_suspended`, measured on `performance.now()`, a clock no network time can move).
  The notice shows, and is announced, only while the call is LIVE - one rule, `callMicNotice`, read
  by the full screen, the bar and the live region alike. When it ends the live region says the
  other party is heard again ONCE, or nothing for this device's own (the toast says it), and never
  falls back to "connected". A `PeerAway` clears the partner's report (no fresh evidence), and each
  pairing (`PeerReady`, first, replaced or resumed) re-announces a microphone still held, so a
  `false` lost with a dropped socket cannot leave the notice stuck. Server half: [call-service](../../services/call-service.md#signal-frames).

**Owed on hardware** (a pre-release carrying this, both phones; the steps are
[CALL-L1](../../device-verification.md#call-l1-a-11-dev-call-between-the-two-bench-phones---owed-on-both)
row 12): the `UIBackgroundModes of the built app:` line of the iOS job lists `audio`; the
iPhone locked 60 s and backgrounded 60 s mid-call - the Mi 9T's inbound audio packets keep rising,
the iPhone logs NO `the system took the microphone`, and the Mi 9T's voice is heard on the locked
iPhone. Three more, because the mode is APP-WIDE and the signal is new: whether a reel and a voice
message now keep PLAYING locked or in the background (a behaviour change to accept or refuse); an
audio route change (AirPods, a wired headset) and a short interruption mid-call, measured for a
`mute`/`unmute` FLICKER - each one would put a false notice on the partner's screen, and no debounce
is written before that rate is read; and a call accepted from the lock screen (the track handed over
already muted). If the mode does not keep the capture, the next candidate is WebKit's own policy,
read from the iPhone's syslog (`pymobiledevice3 syslog live`, `mediaserverd` / `WebKit` lines) - not a
native audio session written blind.

### WP-C-BG-A - the Android ongoing-call service (2026-10-20)

**Why.** Read on the Mi 9T (`1.3.1-alpha.3`, [readings](../../device-readings-2026-10.md), CALL-L1
row 11): locked 40 s or sent HOME 40 s, the call socket was reset 5 s in and both directions of audio
stopped, while the page's JavaScript KEPT RUNNING (a `connection failed` every 4 s in the
background). The process was not frozen, it was cut off from the network and the microphone - what
Android does to a process with nothing in the foreground. A foreground service is the platform's
answer, and the one every calling app holds.

**What is built:**

| Piece | Where | What it does |
|---|---|---|
| The service | `CallForegroundService.kt` | type `microphone`; the ONGOING `CallStyle.forOngoingCall` notification (the peer's name, a chronometer from `CallService.connectedAt`, the system's own hang-up button, a tap brings the task forward with a launcher intent - never a deep link); the audio MODE set only when nobody set it before, and never restored from a saved value (see "The mode has another owner" below); a PARTIAL wake lock released by every end path, acquired for a 4 h period and renewed while the call is up (see "Every end path"); silent channel `canari_call_ongoing`, created on the first call so a build that places none never shows it |
| The route | `CallAudio` in the same file, choice in `call/OngoingCall.kt` (`pickCallOutput`) | speaker on: the loudspeaker; off: the most personal output present - hearing aid, BLE then SCO headset, wired, USB, earpiece - re-chosen when a device comes or goes, logged only when the choice changes. API 28-30: `isSpeakerphoneOn` only (no Bluetooth SCO). Replaces the label-matched `setSinkId` on Android, which found no labelled output on the Mi 9T |
| The transition table | `call/OngoingCall.kt` (`decide`) | start / update / stop / hang-up against the CALL ID in the foreground (null when none); every command is logged with its effect. A start of the running call is a refresh; a start of ANOTHER call while one runs takes the foreground over and logs an ERROR (the earlier call's stop was lost); an update or a stop of a call that is not the running one is an earlier call's command landing late, or one in flight when the service had left - EXPECTED, logged at INFO with that cause; a stop naming no call (the page gone, a new page) stops whatever runs; the notification's hang-up makes the service LEAVE THE FOREGROUND ITSELF and then tells the page, which ends the call - the service's end never waits on a page being there |
| The bridge | `CallBridge.kt` (`window.canariCall`: `start(json)`, `update(json)` - the description plus the `callId` the page draws per call -, `stop(callId, reason)`, `pageLoaded()`) and one DOM event up, `canari:call-native` (`started`, `failed` with a `code` - `off-screen` or `refused` -, `stopped`, `hangup`, `mute`, `foreground`), every one naming its `callId`; the page DROPS an event of another call | registered by `MainActivity` ONLY when the service is in the merged manifest. `start` is refused BEFORE it is attempted when the activity is not RESUMED (`off-screen`) or `RECORD_AUDIO` is not granted (`refused`) - the two preconditions of a microphone service, known here, never learnt from a crash. The start is a PLAIN `startService` (legal: the app is on screen), and the service calls `startForeground` in `onStartCommand`: a refusal is then a logged exception and a `failed` event, where after `startForegroundService` a service stopping without `startForeground` is counted as a crash of the process. A `SecurityException` or `ForegroundServiceStartNotAllowedException` met while the app is NOT on screen (HOME pressed between the bridge's check and `startForeground` on the main thread) is `off-screen`, not `refused` (`classifyStartRefusal`). Every `stopSelf` names its `startId`, so a start delivered before a preceding stop was handled is not destroyed with it |
| The page's side | `lib/mobile/androidCallService.ts`, opened by `CallOverlay` once per call | `ongoingCallSpec` turns the call's status kind into the description (a Paraglide word, never the running timer); `start` once the call HOLDS the microphone and is the caller's `ringing` or the callee's `connecting` - seconds after the tap, so on screen with the grant answered; `update` only on a change; `stop` at `ended`. An `off-screen` refusal is a WARN and is asked ONCE more, with the call's current description, when native sends `foreground` (the activity resumed with that refusal pending) - an EVENT, never a clock; a second refusal, or any `refused`, is an ERROR and final for the call. A build without the bridge logs `ERROR this Android build has no ongoing-call service` once per call. The speaker toggle is shown on Android only when the bridge exists - the route IS the service's - and is DISABLED, labelled "output unavailable for now", while a start waits for `foreground` and once the service is refused or gone for the call |
| Teardown | `MainActivity.onDestroy`, `onTaskRemoved`, `onBackPressed`, `+layout.svelte` | a destroyed activity (its WebView is destroyed with it, and the call) stops the service; a swipe from Recents stops it; a page that LOADS calls `pageLoaded()` once (see "Every end path"); Back at the root during a call moves the task back on API 28-30 (API 31+ does that itself) |

**The mode has another owner (review F1).** Chromium's `AudioManagerAndroid` may set
`MODE_IN_COMMUNICATION` itself when the page opens a capture for a call, and put the mode back when
the capture closes. The service starts AFTER the capture (`micHeld`), so a mode SAVED by the service
would usually already be `MODE_IN_COMMUNICATION`, and "restoring" it after Chromium had put
`MODE_NORMAL` back would leave the process stuck in communication mode. So `CallAudio` never saves
and restores: if the mode already reads `MODE_IN_COMMUNICATION` it is left to its owner (logged
`mode already MODE_IN_COMMUNICATION ... left to its owner`); only otherwise does the service set it,
and only then does it reset it at the end - to `MODE_NORMAL`, and only if it still reads
`MODE_IN_COMMUNICATION`. The OUTPUT (`setCommunicationDevice`, cleared at the end) is the service's
alone. Which branch the WebView actually takes is not read yet: `dumpsys audio` during AND after a
call is in the owed list below.

**Every end path, and none waits on the page (review F2, F6).** A page reload mid-call (the app's own
`window.location.reload` sites, a renderer that crashed and came back) leaves a page with no call
and no listener. So: the notification's hang-up leaves the foreground in the SERVICE and only then
tells the page (with no page attached it logs a WARN and the leaving is the whole answer); and the
root layout calls `releaseCallServiceOfPreviousPage` once per page load on Android, whose
`pageLoaded()` stops a service still running (an orphan of the page before) and says nothing when
none runs, so an ordinary boot is silent. A stop the page asked for, or caused by the page going
(`stopForPageGone`, logged at INFO), sends no `stopped` back - the page knows, or is gone; `stopped`
is reserved for an exit the page did not cause. The wake lock is released by `leave()` on every one
of those paths. Nothing bounds a call's length - the server's 4 h is a Redis room-binding TTL and a
counting cap (`MAX_COUNTED_CALL_SEC`), not a hang-up - so 4 h is only the EXPECTED horizon: the lock
is acquired for 4 h (an acquire with no timeout is what Android's lint names a leak) and RENEWED for
another 4 h, logged at INFO, while the call is still in the foreground. No clock ends a call.

**A refusal for being off screen is answered by the next resume, whatever thread met it.** The
bridge's check runs on a binder thread, `onResume` on the main thread; unlocked, the bridge could
read "not on screen", the activity resume and find nothing pending, and the refusal then be recorded
with no resume left to answer it. `OffScreenGate` (`call/OngoingCall.kt`) holds the pending call id
under one lock, with the reports made inside it and `isInForeground` written before the gate is
asked: every interleaving ends in exactly one of "the start goes ahead" or "`failed` then
`foreground`" - which a 20 000-iteration two-thread test in `OngoingCallTest.kt` asserts.

**Started at `ringing`, not at `incall`** - a deviation from the backlog's wording, for a platform
rule: Android grants a microphone service only to an app that is on screen (`startForeground` with a
while-in-use type throws from the background on API 34+), and a caller who dials then pockets the
phone while it rings would be refused at `incall`.

**`microphone`, not `phoneCall`.** `phoneCall` is for calls placed through Telecom's
`ConnectionService`; Android 14 starts it only for the default dialer or an app holding
`MANAGE_OWN_CALLS` (a self-managed `ConnectionService`). This app has neither, and Android's own
list of `microphone` uses names "communication apps". Moving to `phoneCall` means a self-managed
`ConnectionService`, a larger piece of work with its own Play declaration.

**In the main manifest since the flip (2026-10-22).** The service, `FOREGROUND_SERVICE` and
`FOREGROUND_SERVICE_MICROPHONE` were a `src/calls/AndroidManifest.xml` overlay merged by gradle on
`VITE_DEPLOY_ENVIRONMENT=development`; the overlay and that gradle code are deleted and every build
carries the declaration. `androidCallServiceManifest.test.ts` asserts the main manifest
declares it exactly when `CALLS_COMPILED` is true (not with the native ring's
`CALLS_NATIVE_RING_COMPILED`: an in-app call needs it); `android.yml` reads the BUILT manifests
against the same constant. `CALLS_COMPILED` is true since the flip.

**Google Play.** Since API 34 every foreground service declares a type, and Play asks the developer
to declare each foreground-service permission in the Play Console (App content, "Foreground service
permissions"): per permission, which feature uses it, a description, and a video showing it in use.
**The owner FILLED that declaration on 2026-10-21** (`FOREGROUND_SERVICE_MICROPHONE`, in-app 1:1
calls); what Play's review answers is not known yet. Written before it was filled, and kept for the
record - **two things were unknown:** whether an upload to the
`internal` track (where every pre-release goes, `android.yml`) is refused while the declaration is
missing, and what the review says of `microphone` for in-app calls. **The first pre-release carrying
this is where it shows** - if the Play step of `android.yml` is refused, the GitHub release APK is
still built.

**What was BUILT is checked too.** `android.yml` reads the merged manifest of BOTH artifacts after
the build (the AAB's protobuf manifest through `unzip | grep -a`, its strings are plain UTF-8; the
APK's binary XML through `aapt2 dump xmltree`) and FAILS when `FOREGROUND_SERVICE_MICROPHONE` or
`CallForegroundService` is present while `CALLS_COMPILED` is false - or absent while it is true. `RECORD_AUDIO` is the anchor: a dump that lost it is reported unread, never a pass,
and `CALLS_COMPILED` is parsed as the one exported boolean - anything else fails the step. Since the
flip the declaration is in `src/main/AndroidManifest.xml` and gradle merges nothing, so a stable and a
pre-release carry it alike.

**Pinned by** `androidCallService.test.ts` (start/update/stop with the call id, the one
`foreground`-driven second ask after an `off-screen` refusal and nothing after a second, no stop
after the notification's hang-up, an event of another call dropped, the route's availability, the
page-load release, no bridge), `androidCallServiceManifest.test.ts` (the declaration, the gating,
the workflow step, both sides of the bridge named alike - methods, codes, the `callId` field -, the
plain `startService`, the resume hook) and `OngoingCallTest.kt` (`decide` by call id,
`classifyStartRefusal`, `OffScreenGate` and its race, the spec validation, `pickCallOutput`).
**What none of them proves:** that Android keeps this process's network and microphone with the
service up, that the WebView is not frozen, that Chromium does not override the mode or the output.

**Owed on the Mi 9T** (a build with the service: the next pre-release, or a local debug build -
installing one over a release-signed install costs the enrolment), in a call with the iPhone or a
desktop peer (`callpeer.mjs`): (1) lock 40 s, (2) HOME 40 s - each: the other side keeps hearing the
Mi 9T and the Mi 9T keeps hearing it, no `closed code=1006` and no server `held dead`; (3) the
notification shows the name and a running timer, its hang-up ends the call on both ends; (4) Back
at the root during a call keeps it; (5) speaker / earpiece from the call screen, read with
`adb shell dumpsys audio` (mode `MODE_IN_COMMUNICATION`, the communication device, and WHO set the
mode - Chromium may set it too); (6) `adb shell dumpsys activity services fr.emse.canari` shows the
service `isForeground=true` with `foregroundServiceType=0x80` during the call and gone after;
(7) `adb shell dumpsys audio` AFTER the hang-up: mode `MODE_NORMAL` and no communication device -
the reading that settles the mode's owner (F1 above); (8) reload the page mid-call (any
`window.location.reload` site), then press the notification's hang-up: the service leaves
(`pageLoaded` should already have stopped it - the log says which), nothing stays in the shade;
(9) the FIRST-EVER call on a fresh install, through the microphone permission prompt: the service
starts once the grant is answered, or is refused `off-screen` and started on the `foreground` event -
never neither; (10) swipe the app from Recents mid-call: the notification goes, the peer sees the
call end; (11) connect and disconnect a Bluetooth and a wired headset mid-call: the output follows,
logged once per change; (12) notifications DENIED for the app: the service still holds the call
(Android 13+ hides the notification from the shade, not the service) - read `dumpsys activity
services`. **The API 28-30 paths have NO bench device** - the Back `moveTaskToBack` and the
`isSpeakerphoneOn` route are compiled and unread; the Mi 9T reads `ro.build.version.sdk` = 36
(Android 16, read 2026-10-20), so it exercises only the API 31+ paths.
Log lines to read: `CallFgService`, `CallAudio`, `CallBridge` in `logcat`; `[Call] ongoing-call
service ...` in the app log.

#### A call behaves like a phone call (2026-10-30, after the owner's first production call)

The owner's first production 1:1 audio call (Pixel 6a) worked, and was not a phone call: it started
on the LOUDSPEAKER (the log: `speaker=true` at `connecting` and `live` - `CallOverlay` started every
call there), the screen stayed lit against the cheek, the notification had no photo, and music kept
playing. What changed:

| Defect | Fix | Where |
|---|---|---|
| Every call started on the loudspeaker, and `pickCallOutput` never reads the headsets with the speaker on | The voice STARTS where `callStartsOnSpeaker(video)` says: a VIDEO call on the loudspeaker, an AUDIO call on the earpiece - or a connected headset, which `pickCallOutput` already prefers off the speaker. Decided when the call first holds the microphone (`CallService.hasVideo` is set before the stream is published), moved to the loudspeaker if video shows later; the user's tap on the toggle wins for the rest of the call | `androidCallService.ts`, `CallOverlay.svelte` |
| The screen stayed on against the cheek | Android: `PROXIMITY_SCREEN_OFF_WAKE_LOCK` held while the output `CallAudio` APPLIED is the earpiece (`holdsProximityScreenOff`), released with `RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY` on a move to the speaker or a headset and on every end path; a device without the sensor says so once. iPhone: `UIDevice.proximityMonitoringEnabled` through the `canariProximity` message handler (`canari_ios.mm`), set while the call holds the microphone on the receiver (`iosCallProximity.ts`) | `CallForegroundService.kt`, `canari_ios.mm` |
| No photo on the ongoing notification | The `CallStyle` person carries the peer's photo: `peerUserId` crosses the bridge, `CanariFirebaseMessagingService.callAvatar` - the SAME `fetchAvatar` every message notification uses (push-secret route, 24 h cache, remembered absence) - runs off the main thread, and the notification is re-posted when it lands; it is never held for the picture | `CallForegroundService.kt` |
| Music kept playing | `CallAudio.open` requests `AUDIOFOCUS_GAIN_TRANSIENT` with `USAGE_VOICE_COMMUNICATION`; `close` abandons it. A refusal (a phone call holds the focus) is a WARN and the call goes on | `CallForegroundService.kt` |
| No mute on the notification | A mute / unmute action (`notif_action_call_mute` / `_unmute`, the app's language) sends `ToggleMute` -> `ForwardMute` -> a `mute` event; the page toggles its microphone and its next `update` carries `muted`, so the label shows the CALL's state, never the one a press assumed | `OngoingCall.kt`, `androidCallService.ts` |

**What the review of #2723 added (2026-10-30).**
- **A headset beats the speaker DEFAULT.** The page sends `speakerChosen` (the user's tap, or only
  the call's default); `pickCallOutput` prefers a connected headset over a default loudspeaker,
  never over a tapped one. A video that shows mid-call moves the default to the loudspeaker
  (`nextSpeakerDefault`), and never back. **The toggle shows the route APPLIED** (follow-up): the
  service emits an `output` event (`speaker` true / false, absent when the platform routes) each
  time it applies one, and the overlay shows that over what it asked - so a loudspeaker default that
  yielded to a headset reads "earpiece" and the first tap is the loudspeaker, audibly.
- **The proximity lock follows the screen** (Android): held only with the voice on the earpiece AND
  the app on screen (`MainActivity` resume / pause re-decide it), renewed from a WANTED field, not
  from `isHeld` - a lock that timed out at the renewal mark is re-taken.
- **The iPhone arms the sensor on the RECEIVER route only**: the page asks, and native checks
  `AVAudioSession.currentRoute.outputs` for `Receiver` on every ask and route change, logging the
  port types (`outputs=[...] receiver=...`) - a route change that moved neither the ports nor the
  state writes no line (iOS posts several per switch) - AirPods or a speaker the page did not choose keep the
  screen lit. Every page boot posts `false` once (`releaseIosProximityOfPreviousPage`), so a reload
  or a WebContent kill mid-call never leaves the sensor armed. The navigation delegate is wry's, so
  no native hook on the WebContent kill was added.
- **Audio focus changes are logged** (`audio focus LOSS_TRANSIENT for call=...`), never acted on;
  holding or muting on a loss is a product decision ([backlog](../../backlog.md)).
- The mute action draws a microphone, struck while muted.

**The native incoming ring (item 4 of the study) is NOT in this change**: the in-app ring is still
WebAudio tones at media volume with one 1.8 s vibration (`useNotifications.svelte.ts`), and the
caller hears no ringback. It is owed as its own pull request ([backlog](../../backlog.md)).

**What a gate holds, and what nothing does.** NO CI gate compiles `CallForegroundService.kt`,
`CallBridge.kt` or `CanariFirebaseMessagingService.kt`: `android-tests` compiles only the pure
packages (`call/`, `push/`, `gesture/`, `share/`), which is where `OngoingCallTest` holds
`pickCallOutput`, `holdsProximityScreenOff` and the spec. The whole app's Kotlin was compiled by
hand on 2026-10-30 (`:app:compileArm64DebugKotlin`, BUILD SUCCESSFUL); the Objective-C of
`canari_ios.mm` by nothing until the iOS CI job. **Owed on BOTH phones**: (A) an audio call starts on the EARPIECE - `CallAudio
voice -> EARPIECE (call started)` in `logcat`, `[Call] voice starts on the earpiece` in the app log;
a video call on the loudspeaker; (B) a wired, then a Bluetooth headset connected BEFORE the call:
the voice starts there, a VIDEO call's too; (C) the screen goes dark at the cheek on the earpiece and stays lit on the
speaker and in another app - Android `proximity screen-off held`, iPhone `call proximity (...): page=1 outputs=[Receiver] receiver=1 now=1`;
(D) the caller's photo on the ongoing notification (`caller photo drawn on the call notification`),
and the name alone for an account with none; (E) music playing before the call pauses for it and
resumes after (`audio focus taken`); (F) the notification's mute: the peer stops hearing, the call
screen shows muted, the action reads "Réactiver le micro", a second press undoes it.

**Four log lines the same call's log misread, fixed with it.** (1) `audio_level_in` read `0.000` on
4 ticks of 5 while 32-41 kbps of voice arrived: it was the INSTANTANEOUS `audioLevel`, one sample
per 10 s tick, and the listening side is silent most of the time. `[CALL_REPORT]` now writes the RMS
level OVER THE INTERVAL, `sqrt(dTotalAudioEnergy / dTotalSamplesDuration)` (both directions, `-`
when the engine counts nothing); whether the Android WebView fills those counters is part of the
next phone reading. (2) The ICE line listed the first TWO urls, and TURN is last: it now lists
every url (no query). (3) The E2E success line said `no media around the transform`, which reads
as a failure; it says `PASS - all media went through the E2E transform`. (4) An answered call
ended `outcome=answered-or-unrung`; with no typed outcome the line now names which: `answered`, or
`unrung` for a ring that never left.

## "It stays a long time on encryption before the call" (owner, Android 1.5.3, 2026-10-31)

Nine calls in the owner's log. **The encryption is not slow**: `exportSecret` takes 20-60 ms. What
the owner saw, and what was serial:

- **The label.** `CallOverlay` showed "Vérification du chiffrement..." whenever `e2eProven` was
  false - so through the WHOLE ring, 6-57 s of a person not answering yet. **Fixed:** the line is
  chosen by `callE2eLine(kind, proven)` (`utils/callStatusText.ts`): nothing while `incoming` or
  `ringing` (the status alone), the check from `connecting` on, the shield once proven; the ended
  summary keeps an earned shield and starts no check. Tests per state: `callE2eLine.test.ts`,
  `CallOverlay.svelte.test.ts` ("the encryption line").
- **The callee's answer was strictly serial**: room-token, then an AWAITED "answered" MLS notice
  (0.3-0.7 s), then the ICE servers (up to 764 ms), then `getUserMedia`, then the keys, then the
  socket and the join - 1.2-2.6 s. **Fixed (`acceptCall`):** the token, the ICE servers, the
  microphone and the keys run side by side (`Promise.all`), each logged with its own duration
  (`[Call] setup step <name>: N ms`), then the join. What each depended on, checked: the token is
  where the server refuses, so the notice and the ring-end leave only once it is in hand (a refused
  answer still tells nobody); the ICE servers need only membership (`getIceServers` in
  `calls.service.ts`), and `fetchIceServers` now RETURNS the withheld-relay code instead of setting
  it, so an answer landing after its call ended leaves nothing for the next one; a microphone granted
  beside a refused token is released by `setupMedia`'s own `assertSetupLive`; keys derived for a
  call that ended are zeroed by `setupEncryption`, and the worker dies with the call. **A cost taken
  knowingly (review F7 of #2830):** an answer the server REFUSES (a block set during the ring, a
  closed window) may still light the microphone for a moment, or show the system's permission
  prompt on a first call, before the refusal ends it. A refusal of an answer is rare; every answer
  pays the serial wait. A step stopped because a sibling step failed logs `setup step <name>
  abandoned after N ms (the call ended)`; only the step that failed says `failed`.
- **The "answered" notice is no longer awaited** (`announceAnswered`). Its only reader is a SIBLING
  device of the callee still ringing the same call (`handleCallSignal`, `callMsg.answered`), whose
  ring stops when it lands; nothing on the caller or in the call record waits for it, and the
  server's ring-end (`'answered'`) stops the system surfaces on its own path. So the guarantee it
  carries is kept (it leaves after the token, and still stops the siblings), and only the wait is
  gone. A notice that fails is said at ERROR (`answered notice for <call> not sent - our other
  devices keep ringing until their window closes`). **Not done: prefetching during the ring.** The
  ICE servers would mint a TURN credential per ringing device per ring, declined calls included, and
  a fetch that failed early in a 60 s ring would fail an answer made on a link that works by then;
  in parallel with the token the fetch costs nothing extra.
- **The caller built its peer connection only at `PeerReady`.** It is now built right after the
  join and BEFORE the ring (`initPeerConnection({ awaitingPeer: true })`), with
  `iceCandidatePoolSize: 1`: the engine gathers host, srflx and relay candidates through the ring
  and surfaces them at the first `setLocalDescription`. Nothing that needs the peer runs while it
  waits (`pcAwaitingPeer`): no offer (`offerIfNeeded` returns), no report tick, no E2E path check,
  no video ladder. The transforms are attached in the task that creates each sender, as for every
  build. `PeerReady` ADOPTS it (`adoptRingPeerConnection`): the report and the ladder start, and the
  offer is queued. **Every exit of a ring closes it**: `endCall` closes it at once, not after the
  1.5 s summary (`closeRingPeerConnection` - it holds a TURN allocation for a call nobody answered),
  and `cleanup` closes it on every other path; tested per exit in `CallService.p2p.test.ts` ("the
  peer connection built during the ring is closed on every exit": hang-up, window closed, declined,
  busy, a refused seat, a refused ring, a hang-up during the build). A camera turned on or off
  during the ring acts on it as on any peer connection, and the offer at the adoption carries it.
  **A signalling loss DURING the ring records no outage baseline** (`onPairBroken` skips a peer
  connection still awaiting its peer, and the adoption clears `packetsAtLoss`; review F6 of #2830):
  a baseline read from a connection with no media outlived the ring, so a later outage whose path
  still read `connected` while carrying nothing was never restarted. Tested in
  `CallService.p2p.test.ts` ("a signalling loss during the ring leaves no baseline").
- **`setup_ms` counted the human.** It ran from the tap, so a 40 s ring read as a 40 s setup. Split
  into `ring_ms` (ring start to the answer - on the caller from the moment the ring LEFT, the
  server's fan-out answered, so its own setup before that is not counted as the human's; on the
  callee from its page starting to ring) and `connect_ms` (the answer to the first E2E proof),
  in `[CALL_REPORT]` and on two lines of their own (`[Call] answered (...) ring_ms=N`, `[Call] E2E
  proven ... (connect_ms=N)`); the observables are in
  [calls-revival-plan](calls-revival-plan.md#6-observability---a-call-report-that-carries-evidence).
- **Noise, same log.** `[Call] no Media Session API` was logged 313 times in 46 s of an outgoing
  video ring: the parent re-derives `participants` on every change of the conversations map, so
  `primary` was a NEW object many times a second and the Media Session `$effect` (and the Android
  ongoing-call publish) re-ran with it. They now read `peerTitle` / `peerUserId`, strings a
  re-derivation leaves equal; and `callMediaSession.ts` says each refusal once per call (emptied by
  `clearCallMediaSession`). The reachability probes that kept running after the app paused, and the
  stall counter reading "3/2", are [offline-and-weak-network](../offline-and-weak-network.md#21-no-probe-while-the-app-is-off-screen-and-a-stall-count-that-stops-at-its-limit-2026-10-31).

**Expected callee saving:** the serial 1.2-2.6 s becomes roughly the LONGEST of its four steps
(token ~one round trip, ICE up to 764 ms, the microphone, the keys 20-60 ms) plus the join, and the
0.3-0.7 s notice leaves the path entirely - an estimate of 0.6-1.5 s saved per answer, until the
phones measure it. **Owed (bench phones, Mi 9T and iPhone 12, on a pre-release carrying this):**
`connect_ms` per direction against the log's 1.2-2.6 s; the five `setup step` lines of the callee,
the longest named; on the caller, `ice gathering=` at the adoption line (`complete` or `gathering`
means the pool worked), and a ring cancelled before the answer showing `closing the peer connection
built during the ring` with no `[CALL_REPORT]`; the ring showing no encryption line; one `no Media
Session API` line per call at most.

## Responsibilities

- WebRTC audio/video calls within MLS groups (E2E encrypted).
- CallKit integration on iOS (native incoming call UI, app killed).
- Full-screen intent + ringing on Android.
- Room token management via [`chat-delivery-service`](../../services/chat-delivery.md#calls).
- SFU relay via [`call-service`](../../services/call-service.md) (WebSocket signaling + media forwarding).
- Sibling device detection (call on another device → hide incoming UI).

## Architecture

```
Caller                                Callee
  |                                      |
  | 1. Click call button                 |
  | 2. POST /api/calls/initiate          |
  |    ← roomId + roomToken              |
  |                                      |
  | 3. MLS send: SystemMsg               |
  |    { call_invite, callId, hasVideo }  |
  |    (SILENT push - no generic notif)  |
  | 4. POST /api/calls/ring              |
  |    → backend fans out ring signal     |
  |                                      |
  |                           5. FCM/APNs push arrives
  |                              → ring signal triggers:
  |                                - Android: CallStyle notification
  |                                - iOS: CallKit incoming call
  |                                |
  |                           6. User answers
  |                              → MLS send: SystemMsg { call_answered }
  |                              → POST /api/calls/ring-end (answered)
  |                              |
  | 7. Both connect WebSocket            |
  |    → call-service:3004/ws            |
  |    → Join { room_id, room_token }    |
  |    → WebRTC negotiation              |
  |    → E2E-encrypted media flows        |
  |                                      |
  | 8. Hangup:                           |
  |    → MLS send: SystemMsg { call_hangup }
  |    → POST /api/calls/ring-end (ended)
  |    → close WebSocket                  |
```

## Call signaling (MLS)

Call signaling is carried inside MLS ciphertext for E2E privacy. System messages are sent **silently** (no generic notification):

| SystemMsg event | Sent by | Purpose |
|---|---|---|
| `call_invite` | Caller | Invite group members to a call (`callId`, `hasVideo`) |
| `call_answered` | Callee | Accept the call |
| `call_hangup` | Any participant | End the call |

The separate `POST /api/calls/ring` and `POST /api/calls/ring-end` endpoints handle the push notification layer (the backend cannot read MLS, so the caller's client explicitly tells it to ring other devices). Both are membership-gated.

## Call flow states

| State | Description |
|---|---|
| `idle` | No active call |
| `outgoing` | Call initiated, waiting for callee |
| `incoming` | Receiving a call (ringing UI) |
| `active` | Call connected, media flowing |
| `ended` | Call terminated |

## iOS CallKit integration

When the app is killed, CallKit is the only way to show an incoming call UI. The flow:

1. Caller's client → `POST /api/calls/ring`
2. Backend sends **direct APNs VoIP push** to iOS devices with a `voipToken` (ES256 JWT, topic `<bundle>.voip`), ids only, while the ring is live.
3. `PKPushRegistry` delivers the VoIP push → `CanariReportVoipCall` reports a CallKit call. The design, the rules and what is owed: [the native ring on the iPhone](#the-native-ring-on-the-iphone---pushkit-and-callkit-wp-c6-owner-2026-10-22).
4. User answers → writes `pending_call_accept.json` (group, call, caller, video) → fires accept deep link.
5. App unlocks → TS store drains `pendingCallAccept` → `CallService.answerFromSystemSurface` joins on those facts once the socket is up, with no invite awaited ([an answer from the ring joins on the ring's facts](#an-answer-from-the-ring-joins-on-the-rings-facts-2026-10-30)).
6. CallKit session ended on `didBecomeActive` (handed over to in-app WebRTC).

VoIP push tokens are persisted to `voip_token.txt` and registered via `/api/mls/push/register` (`voipToken` field).

## Android incoming call

`CanariFirebaseMessagingService` handles `call_ring` data pushes:

- Channel `canari_calls` (IMPORTANCE_HIGH, ringtone, `setBypassDnd`)
- `NotificationCompat.CallStyle.forIncomingCall` (API 31+)
- Full-screen intent (`USE_FULL_SCREEN_INTENT`) = `IncomingCallActivity`, a screen that asks - never the answer itself
- `FLAG_INSISTENT` looping ringtone
- 60 s timeout (`setTimeoutAfter`)
- Answer = deep link carrying group, call, video and caller (after the keyguard, from the call screen); Decline = the ring stops and the in-app hangup (`DECLINED`) reaches the caller ([the decline reaches the caller](#a-decline-on-the-ring-reaches-the-caller-2026-10-30))
- Caller named from `display_names.json`, photo from the avatar cache first, the network on a miss ([the native ring ships](#the-native-ring-ships-in-152-owner-2026-10-30))
- An app in front stands back only while its page holds the gateway socket (`foregroundPageRings`); at the PIN gate it rings ([an open app at the PIN gate](#an-open-app-at-the-pin-gate-rang-nothing-153-2026-10-31))

## Ring-end (stop ringing)

`POST /api/calls/ring-end` with reason (`answered` / `cancelled` / `ended`) is sent to **all** members including the caller's own devices. Both platforms also arm a local 60 s timeout for the NATIVE ring; **the iOS generic FCM alert has none** - a delivered banner stays until it is removed, which `call_ring_end` does best effort (by `canariCallId`) and app activation does (`CanariPushCancelMessageNotifications` clears every chat-deep-linked banner).

Ordering: `call_ring_end` must be processed **before** the foreground guard — a stale ring must clear even if the user opened the app.

## Sibling device awareness

`GET /api/calls/sibling-status` checks if another device of the same user is already in a call. Used to suppress incoming call UI on inactive devices.

## Key components

| Component | Role |
|---|---|
| `components/chat/CallOverlay.svelte` | The full-screen call (incoming, outgoing, in call, ended) and the call's one audio sink; mounted for the whole call |
| `components/layout/CallBanner.svelte` | The minimised call: a row of the root layout's banner column |
| `composables/useCallModel.svelte.ts` | The service's stores as runes, the status kind and the duration, for both; the local camera TRACK and the peer's live, unmuted video track |
| `stores/callView.svelte.ts` | `minimised`, and `callStatusKind` |

(Corrected 2026-10-15: this table named `CallUI`, `IncomingCallOverlay`, `CallButton` and
`CallDuration`, none of which exists.)

## Key services

| Service | Role |
|---|---|
| `CallService.ts` | WebRTC peer connection management, media capture, SFU signaling, ring/hangup push triggers |
| `workers/encryption.worker.ts` | E2E frame transform (AES-GCM, MLS-derived key); names a plaintext audio payload that is not Opus, per side, and proves a double encryption ([above](#audio-quality-measured-2026-10-19)); a VP8 frame behind its clear payload header, bound as additional data ([video](#video-lot-2-2026-10-20---vp8-behind-a-clear-header-held-by-every-transceiver)) |
| `utils/callVideoFrame.ts`, `utils/callVideo.ts` | The clear prefix of a video frame and the VP8 codec filter; the camera's constraints, its bitrate cap and `preferVp8` - imported by the rig, never copied |
| `utils/opusPacket.ts` | `isValidOpusPacket` - RFC 6716 section 3.4 rules R1-R7, the worker's witness |
| `utils/callE2eReport.ts` | the E2E worker report as one log line, and the engine facts it is read against ([above](#the-mi-9t-logged-no-worker-line-at-all-131-alpha2---the-worker-is-now-asked)) |
| `utils/callAudio.ts`, `utils/callPresence.ts`, `utils/callFailure.ts` | Sender audio parameters, presence, the typed initiate failure |
| `utils/chat/callSystemMessages.ts` | The ONE writer of a call's timeline record (started row, then final: duration or typed outcome) |

## API endpoints (chat-delivery-service)

| Method | Path | Description |
|---|---|---|
| POST | `/api/calls/initiate` | 403 `CALLS_DISABLED` when the [kill switch](#the-servers-kill-switch-and-the-metered-turn-budget-b12-b7-2026-10-21) is `off` (as are `room-token`, `ring` and `ice-servers`). Verify membership, bind the new room ID to the group (Redis `call:room:<id>`), return a room token + room ID + `ringTimeoutMs`. **Not LiveKit** - the SFU is the in-repo Rust `call-service`; the token is an HS256 JWT signed with `CALL_ROOM_SECRET` (`room_id`, `sub`, `group_id`), valid 5 minutes |
| GET | `/api/calls/room-token` | Get room token for recipient: 403 for a room bound to another group, 410 for an unknown/expired room or after the ring window |
| GET | `/api/calls/ice-servers` | Get ICE server configuration (Cloudflare TURN). STUN only with a typed `turn: { status: 'unavailable', code }` (`TURN_BUDGET_REACHED`, `TURN_METER_UNAVAILABLE`) once Cloudflare's metered egress for the month reaches the budget, or when the meter cannot be read |
| POST | `/api/calls/presence` | Report device presence in call |
| GET | `/api/calls/sibling-status` | Check sibling device call status |
| POST | `/api/calls/ring` | 403 `CALLS_VIDEO_DISABLED` for a video ring when the mode is `audio`. Fan out incoming-call ring to the group members whose [call permission](#the-call-permission---its-own-setting-per-conversation-decided-2026-10-18) allows it |
| PATCH | `/api/mls/groups/:groupId/calls` | Set the caller's call permission for one conversation (`{ allowed: boolean }`) |
| POST | `/api/calls/ring-end` | Stop the ring everywhere |

## See also

- [`services/call-service.md`](../../services/call-service.md) — SFU WebRTC relay
- [`services/chat-delivery.md#calls`](../../services/chat-delivery.md#calls) — Backend call endpoints
- [`protocols/mls-protocol.md`](../../protocols/mls-protocol.md) — E2E encryption for call signaling
- [`live.md`](live.md) — the livestream plan, built on this SFU once calls are revived

## The SFU runs six webrtc majors it has never placed a call on (2026-08-27)

Re-rated P1 -> P3 on 2026-10-01: `CALLS_ENABLED = false` since 2026-09-01, so no user can reach this code; it becomes P1 again the day calling is revived. The open line is in [backlog](../../backlog.d/p3-the-sfu-runs-six-webrtc-majors-it-has-never-placed-a-call-on-2026-0.md).

`apps/call-service` was brought back to compiling on 2026-08-27 after two Dependabot majors (`webrtc` 0.11 -> 0.17, `axum` 0.7 -> 0.8) had merged through a CI hole (closed: the crate is in the Rust matrix now). Verified: it builds, clippy is clean under `--all-features`, its ten unit tests pass. Not one of those ten runs the ICE stack. **Since 2026-10-09 `apps/call-service/tests/relay_path.rs` does, in CI**: two relay-only peers through an in-process TURN server carry a data-channel message and an SRTP packet ([cicd](../../cicd.md)). It places no call through the SFU and no browser peer - a green gate is not a working system.

Six majors of webrtc-rs is a different library. One change is known because it broke the build: `RTCIceServer::credential_type` is gone and its rule moved inside the crate - `RTCIceServer::urls()` returns `ErrNoTurnCredentials` for a `turn:`/`turns:` URL with an empty username or credential, where 0.11 accepted it. A misconfigured TURN entry used to degrade quietly and now fails the WHOLE ICE configuration for that peer connection; `build_rtc_ice_server` warns and names the offending server. The changes that did not break the build cannot be enumerated from a diff: the crate reworked ICE gathering, DTLS and the RTP/RTCP interceptor chain. The next bump (0.20) is a port, not a bump (see the port section below, and `.github/scripts/lib/ceiling.sh`).

**What settles it is one call**: two peers, audio and video, over the SFU, with TURN configured as production configures it (prod HAS it and has never used it) - the relay path, because that is where `ErrNoTurnCredentials` sits and a STUN-only test never touches it. Watch the peer connection reaching `connected`, the terminal ICE line the crate already logs, and whether renegotiation still lands (`main.rs` has a renegotiation path no test covers). It is taken BY HAND, with no call runner written (decided 2026-09-06): `CALLS_ENABLED` is flipped in the LOCAL tree only and put back. The twenty CALL rows (rung 15) stay NEVER RUN, deliberately - calls are UNVERIFIED on this build, not broken.

## The webrtc 0.20 port, measured 2026-09-15

Dependabot #431 offers `webrtc`
0.17.2 -> 0.20.5 and has sat red since 2026-09-07. The ceiling refuses it for the relay-path call,
which is correct, but that refusal said by omission that the bump would otherwise be mechanical, and
it would not. Reproduced locally (`cargo check` with `webrtc = "0.20.5"`, manifest restored
afterwards): **26 errors, with the imports not even resolving.** The crate's root went from about
twenty public modules to FIVE - `data_channel`, `media_stream`, `peer_connection`, `rtp_transceiver`,
`runtime`, plus `error` - so all nineteen of `main.rs`'s `use webrtc::...` lines break: `webrtc::api`,
`webrtc::ice`, `webrtc::ice_transport`, `webrtc::interceptor`, `webrtc::rtcp` and `webrtc::track` no
longer exist.

**0.20 is webrtc-rs re-founded as a thin async layer over the Sans-I/O [`rtc`](https://docs.rs/rtc)
crate**, and the shape of the port is visible from its own documentation:

| 0.17, what this SFU uses | 0.20 |
| --- | --- |
| `APIBuilder` + `MediaEngine` + `SettingEngine` + interceptor `Registry` | one `PeerConnectionBuilder` |
| `RTCPeerConnection`, a struct | `PeerConnection`, a TRAIT, driven by a background `PeerConnectionDriver` |
| `pc.on_track(Box::new(...))` and the other `on_*` closures | a `PeerConnectionEventHandler` trait you implement, async methods |
| `webrtc::track::track_local` / `track_remote` | `media_stream::track_local` / `track_remote` |
| tokio assumed | a `Runtime` trait; `runtime-tokio` is a default cargo FEATURE |

Three names have no same-named replacement at all: `RTCRtpSender` (now the `RtpSender` trait),
`RTPCodecType`, and `TrackLocalWriter`. `RTCPeerConnection` loses `close()` and `add_ice_candidate()`
from its inherent surface. The rest of the types survive by name but move, mostly re-exported from
`peer_connection` out of `rtc`.

**This changes the ORDER of what is owed, not the verdict.** The call is still the gate, because a
ported SFU that compiles is exactly the same nothing the current one is - six majors unplaced becomes
nine majors unplaced. But whoever writes rung 15 CALL to retire the refusal should know they are
retiring it against a crate this service has to be rewritten onto first, and should consider whether
the port and the call belong in the same piece of work. (The refusal itself left the ceiling on 2026-10-09, retired by `relay_path.rs`; the by-hand call stays owed.) The refusal text in
`.github/scripts/lib/ceiling.sh` now says both.
