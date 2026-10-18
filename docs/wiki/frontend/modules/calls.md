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
> **Five things were switched off together and must come back together, in one commit:**
>
> | Switch | Where | What it holds |
> |---|---|---|
> | `CALLS_ENABLED` | `frontend/src/lib/features.ts` | call buttons, `startCall`, `handleCallSignal` |
> | `kCanariCallsEnabled` | `canari_push.mm` | PushKit registry, CallKit provider, `CanariReportIncomingCall` |
> | `CALLS_ENABLED` | `CanariFirebaseMessagingService.kt` | `showIncomingCallNotification` |
> | `voip` | `canari_iOS/Info.plist` `UIBackgroundModes` | PushKit tokens (absent = no token, ever) |
> | `USE_FULL_SCREEN_INTENT` | `AndroidManifest.xml` | the locked-screen CallStyle ring |
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
| `CALLS_COMPILED` | `false` | the store binaries' calling: native ring, `voip`, `USE_FULL_SCREEN_INTENT`. Mirrored by the Kotlin `CALLS_ENABLED`; `callsCompiled.test.ts` asserts all five switches of the table above agree with it ([below](#the-switches-agree-and-a-silent-frame-stays-unread)). The four native switches did NOT move |
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
   that says whether a call was billed. From then on a `[CALL_REPORT]` line every 10 s and one at
   the end carries the same pair plus rates, loss, audio levels and the E2E worker's exact frame
   counts; its fields and ordering guarantees are in
   [calls-revival-plan section 6](calls-revival-plan.md#6-observability---a-call-report-that-carries-evidence).
6. `PeerLeft` (the other socket is gone, or this device was replaced by a sibling) ends the call;
   a second `PeerReady` (the other party's device was replaced) rebuilds the peer connection.
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
`ontrack` never sees a frame - the call connects, packets arrive, every sample is concealed
silence. Attached to the receiver of the transceiver `addTrack` created, before negotiation, every
frame decrypts. `initPeerConnection` now does that; `ontrack` attaching late logs a WARN. The same
session found the worker counting a failed decrypt as `decryptOk` (fixed: `decryptError` only).

**Server half:** [call-service p2p mode](../../services/call-service.md#peer-to-peer-mode-2026-10-17).

**What was verified, and how** (no device, no local estate):

| Claim | Evidence |
|---|---|
| The relay pairs, assigns roles, forwards verbatim, refuses a third user, a token for another group and a mode mismatch, announces a leave and a sibling replacement, and closes a socket on a frame over 64 KiB | `apps/call-service/tests/p2p_signalling.rs` (the real binary over real WebSockets) + `src/p2p.rs` unit tests (incl. the relay never waiting on a full partner queue) |
| A room is bound to its group; a token for it is refused for another group, an unknown room and after the ring window | `apps/chat-delivery-service/src/services/calls.service.spec.ts` |
| The client speaks that protocol (Join p2p, roles, offers only as initiator, answers as polite, refuses without the transform, rebuilds on replacement), honours the ring window on both sides, and writes no missed call for a call that never rang | `CallService.p2p.test.ts` (fakes of WebSocket, RTCPeerConnection, worker) |
| Two Chrome 155 contexts connect DIRECT (`host/udp->host/udp`) through the real relay, the REAL `encryption.worker.ts` encrypts and decrypts Opus, and the callee hears the caller's 440 Hz tone (RMS 0.71, peak 445 Hz) | a scratch page mirroring `CallService`'s negotiation, by hand, chrome-devtools MCP; a wrong key yields only `decryptError` and no decoded sample |
| The signalling socket survives an idle call | the same run: one socket held 3.6 h with only the 25 s keepalive pings (local, no proxy in front) |

**NOT verified - owed:** the real app end to end (no local estate was up); a TURN-relayed call;
anything on the Mi 9T or the iPhone (Android System WebView's and
WKWebView's `RTCRtpScriptTransform`, the late-receiver behaviour on WebKit, microphone permission in
the Tauri WebViews, audio routing); cellular and campus networks; the host nginx's 60 s timeout and
the Cloudflare tunnel in front of dev (the keepalive is there for them, unmeasured through them).

**The dev TURN secrets EXIST since 2026-10-17** (`DEV_CLOUDFLARE_CALLS_API_TOKEN`,
`DEV_CLOUDFLARE_TURN_KEY_ID`, GitHub secrets). `serve-dev.yml` and `env-manifest.tsv` read them, and
`docker-compose.dev.yml` hands them to chat-delivery-service since lot 1 (it did not before - the
secrets alone would have changed nothing). They reach dev at the next pre-release deploy; until then
dev answers 503 on `/api/calls/ice-servers` and every call fails at step 1 - by design, not a
fallback to STUN only.

**Still open from the plan:** the TURN budget estimator (`CALL_RELAY_KBPS_PER_DEVICE`) counts EVERY
call as relayed; in P2P only `relayed=yes` calls cost, so it over-counts (harmless on dev). (A
conversation at `none` ringing an OPEN app was closed on 2026-10-18 by the call permission below.)

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

**WHAT #1997'S REVIEW SAID WAS OWED BEFORE `CALLS_COMPILED` FLIPS IS BUILT (2026-10-18):**

- **F4 - who sees what.** Row C20 and a Cloudflare Realtime TURN processor row in
  [register-of-processing](../../compliance/register-of-processing.md), and the matching paragraphs
  of `/legal/privacy` (sections 2, 3 and 4): each party learns the other's public IP, and so does the
  signalling server that relays the candidates; Cloudflare sees EVERY call (each device's IP and the
  time - the TURN servers are always handed to the peer connection, so relay candidates are always
  gathered) and, for a relayed call, the volume, never the audio; the ring push tells Google/Apple a
  call is arriving.
- **One key per direction, frames bound to their kind** (`utils/callKeys.ts`). Each direction's key is
  `exportSecret(groupId, 'mls-webrtc-media-v2', '<callId>|<sender role>', 32)`; the caller sends
  with `caller` and decrypts with `callee`, the callee the reverse. The worker imports the send key
  for `encrypt` only and the receive key for `decrypt` only, and every frame carries
  `canari-call-v2|<audio|video>` as AES-GCM additional data. **The kind is handed to the worker by
  the page**, in each `RTCRtpScriptTransform`'s options (`{ side, kind }`, the track's own `kind`):
  the worker never infers it from a frame (it used to read the frame's class NAME, an engine detail
  that decided authentication), and a transform carrying no kind forwards nothing and says so. A
  reflected frame, a frame of the other kind all fail, tested on the worker itself
  (`encryption.worker.test.ts`); another call derives
  other keys (`callKeys.test.ts`). **Not covered: replay WITHIN one direction and kind** - a frame
  replayed by someone on the media path decrypts again (no sequence number is bound); DTLS-SRTP's
  own replay protection below the transform is what stands there today.
- **F5 - a mismatch the user SEES.** `DECRYPT_MISMATCH_FAILURES` (100) failures with NOT ONE frame
  decrypted - a count a matching key never reaches, since it decrypts the first frame - logs an
  `ERROR E2E key mismatch` and shows `call_e2e_key_mismatch` once per call. "Decrypted a frame" is
  forgotten when the other party's device is replaced (a second `PeerReady`): the new device derives
  its own keys, and what the old one decrypted proves nothing about them. A key AGREEMENT over the
  signalling channel is not built: the relay carries a closed set of frames, and a mismatch is
  diagnosable from two exported logs, where one side's `send_fp` must equal the other's `recv_fp`.
- **The key log is a hash.** `media keys derived from MLS (role= send_fp= recv_fp=)`: the first 4
  bytes of each key's SHA-256, never key bytes.

What still stands between dev and production is the revival plan's campaign, not this list.

## The switches agree, and a silent frame stays unread

**One test, one fact (2026-10-18).** `frontend/src/lib/mobile/callsCompiled.test.ts` reads
`CALLS_COMPILED` from `features.ts` and asserts that the four other switches of the table at the top
of this page AGREE with it - the Kotlin `CALLS_ENABLED`, the ObjC `kCanariCallsEnabled`, the `voip`
entry of `UIBackgroundModes`, the `USE_FULL_SCREEN_INTENT` tag - and that the microphone purpose
string (base `Info.plist`, `fr.lproj`, `en.lproj`) names calls exactly when calls are compiled. It
replaced three tests that each asserted "off" (`iosCallDeclarations.test.ts`, two cases of
`androidFcmManifest.test.ts`, one of `pushSilentDecrypt.test.ts`): a hard-coded "off" fails the
revival commit for doing its job, an agreement fails it only when it forgets one of the five. Read
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
for a group ([backlog](../../backlog.md#p3-owed-by-wp-c11---one-block-refuses-a-whole-group-call)).

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
| `components/chat/CallOverlay.svelte` | The whole call UI: incoming, outgoing, in-call controls, duration, E2E badge |

(Corrected 2026-10-15: this table named `CallUI`, `IncomingCallOverlay`, `CallButton` and
`CallDuration`, none of which exists.)

## Key services

| Service | Role |
|---|---|
| `CallService.ts` | WebRTC peer connection management, media capture, SFU signaling, ring/hangup push triggers |
| `workers/encryption.worker.ts` | E2E frame transform (AES-GCM, MLS-derived key) |
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
