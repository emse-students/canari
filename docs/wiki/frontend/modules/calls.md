# Calls module

**Routes**: `src/routes/calls/` (if standalone)  
**Components**: `src/lib/components/calls/`, `src/lib/composables/useCallSession.svelte.ts`  
**Service**: `src/lib/services/CallService.ts`

> **SINCE 2026-10-17 (LOT 1): IN-APP 1:1 AUDIO IS ON FOR DEV BUILDS ONLY, PEER TO PEER** - see
> [lot 1](#lot-1-2026-10-17---11-audio-peer-to-peer-dev-builds-only) below. Everything else in this
> banner still holds for production and for the native ring: `CALLS_COMPILED = false`.
>
> **THE WHOLE SURFACE WAS HELD OFF SINCE 0.14.15 - `CALLS_ENABLED = false`
> (`frontend/src/lib/features.ts`).** Everything below still describes the code exactly, and none of
> it was deleted; none of it RUNS. The reason is that it never did: the campaign board carries twenty
> CALL rows and not one has ever been executed, the SFU has never had a peer connection opened
> against it, and no iPhone ever registered a PushKit token, so no CallKit ring was ever deliverable.
> App Review refused the `voip` background mode under guideline 2.5.4 on 2026-08-31 for a VoIP
> service it could not locate - correctly, on the build it tested.
>
> **Five things were switched off together, and the `audio` mode joined them on 2026-10-20; all six come back together, in one commit:**
>
> | Switch | Where | What it holds |
> |---|---|---|
> | `CALLS_ENABLED` | `frontend/src/lib/features.ts` | call buttons, `startCall`, `handleCallSignal` |
> | `kCanariCallsEnabled` | `canari_push.mm` | PushKit registry, CallKit provider, `CanariReportIncomingCall` |
> | `CALLS_ENABLED` | `CanariFirebaseMessagingService.kt` | `showIncomingCallNotification` |
> | `voip` | `canari_iOS/Info.plist` `UIBackgroundModes` | PushKit tokens (absent = no token, ever) |
> | `USE_FULL_SCREEN_INTENT` | `AndroidManifest.xml` | the locked-screen CallStyle ring |
> | `audio` (since 2026-10-20) | `canari_iOS/Info.plist` `UIBackgroundModes` | the microphone of a hidden or locked iPhone ([WP-C-BG-I](#wp-c-bg-i---the-iphones-microphone-in-the-background-2026-10-20)); every PRE-RELEASE build gets it from `ios.yml` |
>
> **A SIXTH THING MOVED WHILE CALLS WERE OFF, AND IT IS NOT A SWITCH (2026-09-22).** A push payload
> no longer carries `senderName` or `groupName` on a SILENT frame: those two are unbounded user text,
> the payload is cleartext to FCM and to APNs, and nothing read them there - measured on both
> clients. **A `call_invite` is a silent frame**, and `showIncomingCallNotification` takes both names
> from exactly those fields, so on the day calls come back that banner would be titled with nothing.
> Reviving them means taking the name from the device's own store (the FCM cache already holds one
> per conversation) or delivering an invite as an alert push - **not restoring the fields**, which
> would put every student's name back in front of Google on every read receipt.
> ([push-payload](../../../../apps/chat-delivery-service/src/services/push-payload.ts),
> [chat-delivery](../../services/chat-delivery.md#transport--single-gateway-fcm))
>
> **A SEVENTH (2026-10-14): A CONVERSATION AT `none` SENDS EVERY FRAME SILENT, A CALL INVITE
> INCLUDED.** The per-conversation level (`dm_group_members.notifLevel`) is applied in
> `sendFcmForQueued` to whatever frame would draw, and an MLS `call_invite` is one of them: at `none`
> it arrives silent and will NOT ring; at `mentions` it still rings, because both native handlers
> branch on `call_invite` BEFORE the level gate is reached. **DECIDED 2026-10-18: a ring obeys the
> conversation's own CALL PERMISSION, not the level** - see
> [the call permission](#the-call-permission---its-own-setting-per-conversation-decided-2026-10-18).
> ([chat-delivery](../../services/chat-delivery.md#a-conversations-notification-level---the-server-applies-none-the-device-decides-mentions))

> The two platform declarations are the ones a store checks, and each cuts both ways: declared but
> unused is a rejection, used but undeclared cannot work. **Revival condition: rung 15 CALL and
> CALL-13 pass on real hardware** ([board](../../cross-client-testing.md),
> [backlog](../../backlog.md)). `CallService.callsEnabled.test.ts` already asserts the on state, so
> the flip has a test the day it happens.
>
> **The ordered plan to revive calls** - the decisive tests first, the test matrix, the App Review
> video and a server-side switch in place of the five above - is
> [calls-revival-plan](calls-revival-plan.md) (draft, 2026-10-15).

> **AN EIGHTH, AND IT IS THE NETWORK (measured 2026-10-15): FROM PRODUCTION AS BUILT, NO CALL CAN
> CONNECT.** The host cannot send UDP to the internet, and the SFU's TURN client (webrtc-rs 0.17)
> speaks only UDP 3478 to Cloudflare TURN; the two transports that DO leave the host (TCP 80, TLS
> 443) are the two it cannot use. No inbound port is needed. The minimal ask to the DSI is ONE
> outbound rule, and it belongs in the revival commit's preconditions
> ([realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md)).

## Lot 1 (2026-10-17) - 1:1 audio, peer to peer, dev builds only

**What it is.** The user's 2026-10-16 decision made concrete: a 1:1 call goes DIRECT between the
two clients, with Cloudflare TURN as the last resort, and the host carries only signalling over the
443 it already serves. The host cannot send UDP out (the School border), so the SFU path can never
connect from production ([realtime-media-feasibility](../../infrastructure/realtime-media-feasibility.md#8-what-works-with-no-port-opened-by-the-dsi-measured-2026-10-16)).
Nothing in this lot needs the DSI.

**The switches** (`frontend/src/lib/features.ts`, pinned by `features.test.ts`):

| Constant | Value | Holds |
|---|---|---|
| `CALLS_COMPILED` | `false` | the store binaries' calling: native ring, `voip`, `audio` (since 2026-10-20), `USE_FULL_SCREEN_INTENT`. Once it flips, the committed plist carries `audio` and `ios.yml`'s pre-release patch finds it there and adds nothing (it is idempotent; it can then be deleted). Mirrored by the Kotlin `CALLS_ENABLED`; `callsCompiled.test.ts` asserts all six switches of the table above agree with it ([below](#the-switches-agree-and-a-silent-frame-stays-unread)). The four native switches did NOT move |
| `CALLS_ENABLED` | `CALLS_COMPILED \|\| deployEnvironment() === 'development'` | the in-app call buttons, `startCall`, `handleCallSignal`, the sibling check |
| `CALLS_VIDEO_ENABLED` | `false` | the video-call button and both camera toggles; waits for WP-C3 (whole-frame encryption vs H.264) |

`VITE_DEPLOY_ENVIRONMENT=development` is written by `build.yml` for the dev web estate and by
`android.yml` / `ios.yml` for every pre-release - and those pipelines refuse a pre-release whose
backend is not `dev.canari-emse.fr`. A production build never sets it. So: **dev web + alpha apps
call; production web and stable apps do not.** A local workstation build sets nothing either; set
`VITE_DEPLOY_ENVIRONMENT=development` in `frontend/.env` to call locally (it also raises the banner).

**The flow.** Ring and hangup are unchanged (MLS `call_invite` / `call_answered` / `call_hangup`,
silent, over the chat socket - so an OPEN app rings; a killed one does not, that is `CALLS_COMPILED`).
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
   relayed=yes|no [relay_proto=] [rtt_ms=]` (`utils/callStats.ts`, no address) - the only place
   that says whether a call was billed.
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

**NOT verified - owed:** the real app end to end (no local estate was up); a TURN-relayed call;
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

**Still open from the plan:** the TURN budget estimator (`CALL_RELAY_KBPS_PER_DEVICE`) counts EVERY
call as relayed; in P2P only `relayed=yes` calls cost, so it over-counts (harmless on dev). (A
conversation at `none` ringing an OPEN app was closed on 2026-10-18 by the call permission below.)

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
| The in-app invite (MLS `call_invite` over the chat socket - ciphertext the server cannot read) | **the client**, from its copy in `notificationPreferences` | `CallService.handleCallSignal` does not ring (logged); `handleCallSignalForChat` writes the call as **MISSED at once** (`recordCallMissed`, final - the caller's later hangup leaves it), so the line is in the conversation instead of the ring. One predicate, one timeline writer |
| A native handler that decrypts a `call_invite` push (Android `CanariFirebaseMessagingService`, iOS) | **owed at revival** (WP-C5 / WP-C6), from the device's local copy - today `CALLS_COMPILED = false` and no native ring runs | - |

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

**OWED BEFORE `CALLS_COMPILED` FLIPS** (the review of #1997, 2026-10-17; none of it blocks a dev-only
build, all of it blocks production):

- **F4 - say who sees what.** `iceTransportPolicy: 'all'` lets each party learn the other's public
  IP, and Cloudflare (TURN) becomes a recipient of call metadata and relayed media. Both belong in
  `docs/wiki/compliance/register-of-processing.md` and on `/legal/privacy` before production calls.
- **F5 - a key both ends AGREE on, or a failure the user SEES.** Each side derives its key alone
  (`exportSecret(groupId, 'mls-webrtc-media', callId)`); two devices at different MLS epochs derive
  different keys and the call "connects" in silence. Owed: an epoch/fingerprint agreement over the
  signalling channel, or at least a visible "decrypt failing" toast driven by the worker's
  `decryptError` count.
- **One key, both directions, no AAD.** The same AES-GCM key encrypts both parties' frames and the
  frame header is not bound as additional data; a per-direction key (or the sender's leaf index in
  the IV/AAD) closes the nonce-collision and reflection questions.
- **The `fp=` log line prints the first 4 BYTES OF THE KEY** (`CallService.setupEncryption`). Log a
  hash of the key instead (e.g. the first bytes of SHA-256), never key material.

## The switches agree, and a silent frame stays unread

**One test, one fact (2026-10-18).** `frontend/src/lib/mobile/callsCompiled.test.ts` reads
`CALLS_COMPILED` from `features.ts` and asserts that the other switches of the table at the top
of this page AGREE with it - the Kotlin `CALLS_ENABLED`, the ObjC `kCanariCallsEnabled`, the `voip`
and (since 2026-10-20) `audio` entries of `UIBackgroundModes`, the `USE_FULL_SCREEN_INTENT` tag -
that `ios.yml` adds `audio` to a pre-release build in the branch that turns in-app calls on, and that the microphone purpose
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
reads the switch again. The MLS `call_invite` branch below it serves only a NON-silent invite from a
pre-WP-XP-5 caller.

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
for a group ([backlog](../../backlog.md#p1-blocks-calls_compiled-not-dev---four-things-owed-before-production-calls-review-of-1997-2026-10-17)).

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
reading's `TURN CreatePermission error response` (403 and 600, CALL-TURN) is a dev TURN credential
or binding question and stays listed there; no production setting was read or changed.

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
| Mi 9T report, both roles, iPhone and desktop as peers | `frames in` ~250 per side at 5 s, `E2E path check: no media around the transform`, `E2E proven` within a second of `connected` |
| Mi 9T hearing the iPhone | no NetEq `Decode error` flood, concealed near 0 % (CALL-AUDIO-1 closes here or it was not this) |
| iPhone hearing the Mi 9T | `decrypted audio` growing, `decrypt-failed` ~0, the voice audible |
| desktop Chrome via `callpeer.mjs` | the same report as the Mi 9T |
| a call to an OLD (`<=1.3.1-alpha.3`) Chromium client | its clear media fails every decrypt here; the new side's own transforms are fed, so it is not ended by its check, but the OLD side never gets `e2eProven` - expected, dev-only |

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

### Ringing, announcing, hearing

- **The ring is an `alertdialog` with focus on Accept** (`preventScroll`); once answered it is a
  plain `dialog`. ONE `role="status"` region, outside the full screen so it survives a minimise,
  announces each state change - "Appel connecte" rather than the timer, which would speak every second.
- **A refused voice says so.** A WebView may refuse `play()` without a gesture (`NotAllowedError`);
  the voice usually arrives seconds after the last tap. `utils/callVoice.ts` tells that refusal from
  any other failure, the screen and the bar say "Toucher pour entendre", and the NEXT pointer event
  anywhere (or the Accept tap, which primes the sink) starts it. Logged: `[Call] WARN voice refused
  without a gesture (<why>) - waiting for a tap`.
- **A second call while one is up is not rung, and nothing is sent back.** A hangup would reach the
  whole conversation - our own other devices included, which may be free to answer it. Logged:
  `[Call] invite <callId> in <groupId> not rung - busy (state=... call=...)`
  (`CallService.p2p.test.ts`, "a second call while one is up").
- **The 64px controls are size-checked on the RENDERED screen**, not by `iconButtonScale.test.ts`:
  they are drawn by a snippet that markup scan cannot see through. `CallOverlay.svelte.test.ts`
  holds every button of the ring and of the call to `ui-icon-button` or `size-16`; the bar's buttons
  are plain markup and stay under the scan.

## The call in the background (2026-10-19)

**The timer is a function of timestamps**: `CallService.connectedAt` (first `connected`, not the
tap) and `endedAt`, read by `utils/callClock.ts`; the 1 s interval and a `visibilitychange` only
REPAINT it. A throttled or frozen page is right on its first frame back.

**One audio sink for the whole call.** It used to live in each of the old overlay's two views, so
minimising destroyed the element playing the voice and built another. `CallOverlay` is mounted for
the whole call and holds the only `<audio>`; every `<video>` is muted.

**What the web can and cannot do** (what each engine does is unmeasured; the native half is a
backlog item, [P1 - a call does not survive the app leaving the screen](../../backlog.md#p1-blocks-calls_compiled-not-dev---a-call-does-not-survive-the-app-leaving-the-screen-on-either-phone-2026-10-19)):

| Concern | Web (done) | Native (owed) |
|---|---|---|
| The OS knows a call is up | Media Session: title = the peer, `hangup` / `togglemicrophone` handlers, `setMicrophoneActive` (Chromium) - `utils/callMediaSession.ts`, each action in its own `try`, each refusal logged | Android: BUILT, [below](#wp-c-bg-a---the-android-ongoing-call-service-2026-10-20) (a `microphone` foreground service, not `phoneCall`); iOS CallKit for EVERY call (owed) |
| The microphone in the background | nothing can hold it: Android 9+ gives a backgrounded app silence; WKWebView stops capture when hidden | Android: the foreground service (BUILT); iOS: an `AVAudioSession` call session (owed) |
| Audio route (speaker, earpiece, Bluetooth) | iOS only: label-matched `setSinkId`, best effort, logged when there is nothing to route to | Android: `AudioManager.setCommunicationDevice` in the service (BUILT); iOS: `AVAudioSession` (owed) |
| Screen wake lock | **deliberately none for audio**: a phone call lets the screen go dark in the pocket; a lock would light it | video (WP-C3) can take one |
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

- **The `audio` mode on every PRE-RELEASE iPhone build**, patched by `ios.yml` in the SAME branch that
  writes `VITE_DEPLOY_ENVIRONMENT=development` (the line that turns in-app calls on), never into the
  committed `Info.plist`. A stable cannot call (`CALLS_COMPILED = false`), and a mode declared and
  unused is what App Review refused once (2.5.4). It becomes the SIXTH switch: `callsCompiled.test.ts`
  asserts the committed mode follows `CALLS_COMPILED` and that `ios.yml` adds it only in that branch.
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
row 12): the `UIBackgroundModes of this pre-release build:` line of the iOS job lists `audio`; the
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
| The bridge | `CallBridge.kt` (`window.canariCall`: `start(json)`, `update(json)` - the description plus the `callId` the page draws per call -, `stop(callId, reason)`, `pageLoaded()`) and one DOM event up, `canari:call-native` (`started`, `failed` with a `code` - `off-screen` or `refused` -, `stopped`, `hangup`, `foreground`), every one naming its `callId`; the page DROPS an event of another call | registered by `MainActivity` ONLY when the service is in the merged manifest. `start` is refused BEFORE it is attempted when the activity is not RESUMED (`off-screen`) or `RECORD_AUDIO` is not granted (`refused`) - the two preconditions of a microphone service, known here, never learnt from a crash. The start is a PLAIN `startService` (legal: the app is on screen), and the service calls `startForeground` in `onStartCommand`: a refusal is then a logged exception and a `failed` event, where after `startForegroundService` a service stopping without `startForeground` is counted as a crash of the process. A `SecurityException` or `ForegroundServiceStartNotAllowedException` met while the app is NOT on screen (HOME pressed between the bridge's check and `startForeground` on the main thread) is `off-screen`, not `refused` (`classifyStartRefusal`). Every `stopSelf` names its `startId`, so a start delivered before a preceding stop was handled is not destroyed with it |
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

**Only in builds that place calls.** `src/calls/AndroidManifest.xml` (the service,
`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`) is merged by `app/build.gradle.kts` into the
debug and release build types when `VITE_DEPLOY_ENVIRONMENT` is `development` - read from the process
environment, then `frontend/.env`, the order Vite reads them, and printed by Gradle
(`Canari ongoing-call service: IN this build ...`). That is every pre-release and a local build that
sets it; a stable merges nothing. `androidCallServiceManifest.test.ts` asserts the main manifest
declares it exactly when `CALLS_COMPILED` is true - so the revival commit moves it into
`src/main/AndroidManifest.xml` with the five switches, or fails there. `CALLS_COMPILED` stays false.

**Google Play.** Since API 34 every foreground service declares a type, and Play asks the developer
to declare each foreground-service permission in the Play Console (App content, "Foreground service
permissions"): per permission, which feature uses it, a description, and a video showing it in use.
**Not verified against this app's console, and two things are unknown:** whether an upload to the
`internal` track (where every pre-release goes, `android.yml`) is refused while the declaration is
missing, and what the review says of `microphone` for in-app calls. **The first pre-release carrying
this is where it shows** - if the Play step of `android.yml` is refused, the GitHub release APK is
still built, and the declaration is a one-off for the user ([backlog](../../backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)).

**What was BUILT is checked too.** `android.yml` reads the merged manifest of BOTH artifacts after
the build (the AAB's protobuf manifest through `unzip | grep -a`, its strings are plain UTF-8; the
APK's binary XML through `aapt2 dump xmltree`) and FAILS when `FOREGROUND_SERVICE_MICROPHONE` or
`CallForegroundService` is present in a stable while `CALLS_COMPILED` is false - or absent from a
pre-release. `RECORD_AUDIO` is the anchor: a dump that lost it is reported unread, never a pass,
and `CALLS_COMPILED` is parsed as the one exported boolean - anything else fails the step. **When
`CALLS_COMPILED` flips to true, a stable FAILS this step by design**: gradle still merges the
service only on `VITE_DEPLOY_ENVIRONMENT=development`, so the revival commit must move the
declaration into `src/main/AndroidManifest.xml` (the manifest test holds it to that) before a stable
can pass.

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
2. Backend sends **direct APNs VoIP push** to iOS devices with a `voipToken` (ES256 JWT, topic `<bundle>.voip`).
3. `PKPushRegistry` delivers the VoIP push → `CanariReportIncomingCall` reports a CallKit call.
4. User answers → writes `pending_call_accept.json` → fires accept deep link.
5. App unlocks → TS store drains `pendingCallAccept` → `CallService` auto-accepts when the matching MLS invite arrives over WS.
6. CallKit session ended on `didBecomeActive` (handed over to in-app WebRTC).

VoIP push tokens are persisted to `voip_token.txt` and registered via `/api/mls/push/register` (`voipToken` field).

## Android incoming call

`CanariFirebaseMessagingService` handles `call_ring` data pushes:

- Channel `canari_calls` (IMPORTANCE_HIGH, ringtone, `setBypassDnd`)
- `NotificationCompat.CallStyle.forIncomingCall` (API 31+)
- Full-screen intent (`USE_FULL_SCREEN_INTENT`)
- `FLAG_INSISTENT` looping ringtone
- 60 s timeout (`setTimeoutAfter`)
- Answer = deep link; decline = local dismiss

## Ring-end (stop ringing)

`POST /api/calls/ring-end` with reason (`answered` / `cancelled` / `ended`) is sent to **all** members including the caller's own devices. Both platforms also arm a local 60 s timeout.

Ordering: `call_ring_end` must be processed **before** the foreground guard — a stale ring must clear even if the user opened the app.

## Sibling device awareness

`GET /api/calls/sibling-status` checks if another device of the same user is already in a call. Used to suppress incoming call UI on inactive devices.

## Key components

| Component | Role |
|---|---|
| `components/chat/CallOverlay.svelte` | The full-screen call (incoming, outgoing, in call, ended) and the call's one audio sink; mounted for the whole call |
| `components/layout/CallBanner.svelte` | The minimised call: a row of the root layout's banner column |
| `composables/useCallModel.svelte.ts` | The service's stores as runes, the status kind and the duration, for both |
| `stores/callView.svelte.ts` | `minimised`, and `callStatusKind` |

(Corrected 2026-10-15: this table named `CallUI`, `IncomingCallOverlay`, `CallButton` and
`CallDuration`, none of which exists.)

## Key services

| Service | Role |
|---|---|
| `CallService.ts` | WebRTC peer connection management, media capture, SFU signaling, ring/hangup push triggers |
| `workers/encryption.worker.ts` | E2E frame transform (AES-GCM, MLS-derived key); names a plaintext audio payload that is not Opus, per side, and proves a double encryption ([above](#audio-quality-measured-2026-10-19)) |
| `utils/opusPacket.ts` | `isValidOpusPacket` - RFC 6716 section 3.4 rules R1-R7, the worker's witness |
| `utils/callE2eReport.ts` | the E2E worker report as one log line, and the engine facts it is read against ([above](#the-mi-9t-logged-no-worker-line-at-all-131-alpha2---the-worker-is-now-asked)) |
| `utils/callAudio.ts`, `utils/callPresence.ts`, `utils/callFailure.ts` | Sender audio parameters, presence, the typed initiate failure |
| `utils/chat/callSystemMessages.ts` | Call started/ended/missed messages in the timeline |

## API endpoints (chat-delivery-service)

| Method | Path | Description |
|---|---|---|
| POST | `/api/calls/initiate` | Verify membership, bind the new room ID to the group (Redis `call:room:<id>`), return a room token + room ID + `ringTimeoutMs`. **Not LiveKit** - the SFU is the in-repo Rust `call-service`; the token is an HS256 JWT signed with `CALL_ROOM_SECRET` (`room_id`, `sub`, `group_id`), valid 5 minutes |
| GET | `/api/calls/room-token` | Get room token for recipient: 403 for a room bound to another group, 410 for an unknown/expired room or after the ring window |
| GET | `/api/calls/ice-servers` | Get ICE server configuration (Cloudflare TURN) |
| POST | `/api/calls/presence` | Report device presence in call |
| GET | `/api/calls/sibling-status` | Check sibling device call status |
| POST | `/api/calls/ring` | Fan out incoming-call ring to the group members whose [call permission](#the-call-permission---its-own-setting-per-conversation-decided-2026-10-18) allows it |
| PATCH | `/api/mls/groups/:groupId/calls` | Set the caller's call permission for one conversation (`{ allowed: boolean }`) |
| POST | `/api/calls/ring-end` | Stop the ring everywhere |

## See also

- [`services/call-service.md`](../../services/call-service.md) — SFU WebRTC relay
- [`services/chat-delivery.md#calls`](../../services/chat-delivery.md#calls) — Backend call endpoints
- [`protocols/mls-protocol.md`](../../protocols/mls-protocol.md) — E2E encryption for call signaling
- [`live.md`](live.md) — the livestream plan, built on this SFU once calls are revived

## The SFU runs six webrtc majors it has never placed a call on (2026-08-27)

Re-rated P1 -> P3 on 2026-10-01: `CALLS_ENABLED = false` since 2026-09-01, so no user can reach this code; it becomes P1 again the day calling is revived. The open line is in [backlog](../../backlog.md#p3-blocked-calls-held-off---the-sfu-runs-six-webrtc-majors-it-has-never-placed-a-call-on-2026-08-27).

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
