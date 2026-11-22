## Group calls go peer to peer in a MESH up to 4 in audio and 3 in video, a relay SFU beyond (owner decision D-A, 2026-10-31, not built - feeds WP-C11)

target: 1.8.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

**The decision.** A group call is a full mesh of the 1:1 peer connections the app already makes -
every participant holds one `RTCPeerConnection` per other participant, each with its own E2E
transforms - for up to **4 participants in audio** and **3 in video**. Beyond that, the call goes
through a relay SFU (the WP-C4 question: Cloudflare Realtime or the Rust `call-service`,
[calls-revival-plan](../frontend/modules/calls-revival-plan.md#10-the-work-packages-in-order)). Nothing of
it is built: it is the input of WP-C11.

**Why those two numbers - the Q3 mesh measurement** (client probes, section 14 of the revival plan, run 2026-10-16/17)
([calls-revival-plan](../frontend/modules/calls-revival-plan.md#14-probes-of-2026-10-16-clients)).
A mesh costs each SENDER one encode and one upload PER RECEIVER:

- desktop (Ryzen 7 7800X3D) sending 720p at 1.5 Mbit/s to two receivers: holds, 1.45-1.6 Mbit/s
  and 24-30 fps each, ~3.7 ms of encode per frame per receiver, whole-PC CPU 13.2 % against 9.1 %
  idle;
- the **Mi 9T (2019) as the sender to two receivers: fps dips to 18-23 every few seconds, 19-24 ms
  of encode per frame PER RECEIVER, Chrome at ~110 %** - two video receivers already strain the
  bench's oldest phone. So video stops at 3 participants (2 receivers each).
- Audio is cheap by comparison: the app caps Opus at **48 kbit/s** a sender
  (`AUDIO_BITRATE_VOICE`, `utils/callAudio.ts`; the audio rig reads ~50 kbit/s on the wire,
  [calls](../frontend/modules/calls.md#audio-quality-measured-2026-10-19)), so a 4-way audio mesh
  uploads **~3 x 48 = ~150 kbit/s** per participant and encodes Opus three times - within any
  phone's budget. 4 is where the uplink on a weak cellular link and the per-peer ICE/TURN cost
  start to matter more than the CPU.

### Decided by the owner on 2026-11-01 (D1-D4)

Owner, verbatim: *"En ce qui concerne l'UDP ouvert par la DSI, on ne l'aura pas tout de suite. Je
pense que ce serait bien que call-service puisse fonctionner, au cas où on l'a un jour."*

- **D1 - the switch: EVERYONE moves to the relay SFU, mid-call.** When a live mesh outgrows its cap
  (a 5th participant in audio, a 4th in video), every participant renegotiates onto the SFU; the
  call is neither refused nor stripped of its video. The E2E frame transforms stay in the path
  throughout, with NO window where media flows around them: every sender and transceiver the SFU
  leg creates gets its transform in the task that created it
  ([durable-rules](../durable-rules.md#calls-and-their-record---call-service)), so the SFU leg never
  carries a clear frame, and a mesh leg is closed only once the SFU leg is proven - frames its
  transforms encrypted and decrypted, the same evidence the 1:1 call's "chiffre de bout en bout" is
  earned from.
- **D2 - both relays, one server-side setting picks.** Cloudflare's hosted SFU (Realtime) serves NOW,
  because it needs nothing from the School's IT department. Our Rust `call-service` is restored and
  kept WORKING for the day the School opens UDP to it. Which one a call uses is ONE server-side
  setting, not a client build.
- **D3 - `call-service` is proven by an end-to-end call in CI.** GitHub's runners have UDP: the
  binary, a throwaway coturn and two real browsers place an encrypted call on every change that
  touches the service, with no ask to the IT department. **Built 2026-11-01**: the job
  `test-call-service-e2e`, the harness `apps/call-service/e2e/`
  ([call-service](../services/call-service.md#the-end-to-end-call-in-ci)).
- **D4 - no IP masking.** Direct peer-to-peer stays as it is today (`iceTransportPolicy: 'all'`,
  each party may learn the other's address); a mesh leg is a 1:1 leg and inherits that.

### Open design points

1. ~~**The mesh-to-SFU switch.**~~ **Decided, D1 above.**
2. ~~**Which SFU** (WP-C4).~~ **Decided, D2 above: both, one setting.** The fact Q4 left
   unverified - whether Cloudflare's raw SFU forwards transformed frames - is **answered YES on
   2026-11-13** (run [43521609635](https://github.com/emse-students/canari/actions/runs/43521609635):
   252 audio + 151 VP8 frames decrypted through two Cloudflare sessions, 0 failed, every one
   byte-identical; [calls-revival-plan](../frontend/modules/calls-revival-plan.md#14-probes-of-2026-10-16-clients)).
3. ~~**Keys in a mesh.**~~ **Built (WP-GC1, 2026-11-13)**: one key per sender, label
   `mls-webrtc-media-group-v1`, context `<callId>|<userId>`; the 1:1 call keeps its v2 per-direction
   keys, so no shim ([calls](../frontend/modules/calls.md#one-key-per-sender-wp-gc1-2026-11-13)).
4. **TURN volume.** A relayed mesh pays Cloudflare TURN per pair, so a 4-way mesh with every leg
   relayed is 12 streams of egress: read against the B7 budget
   ([calls](../frontend/modules/calls.md#the-turn-budget-reads-cloudflares-meter-b7)).

### The next work packages, in order (not started)

Each is one pull request or more; none is built by the D3 change.

1. **WP-GC1 - per-sender media keys** (open point 3): **built 2026-11-13** - the derivation and the
   worker's per-participant receive keys
   ([calls](../frontend/modules/calls.md#one-key-per-sender-wp-gc1-2026-11-13)).
2. **WP-GC2 - the mesh**: `call-service`'s peer-to-peer room grows from two seats to the cap (4 in
   audio, 3 in video) with addressed signalling (`to`/`from` per frame), and the client holds one
   peer connection per other participant, each armed as the 1:1 one is. **Server half BUILT
   2026-11-13** (the seats, the addressing, the signed cap, `group_calls_mode` OFF in production,
   the client-version gate, WP-C11's block and ring-end rules:
   [calls](../frontend/modules/calls.md#group-calls---the-mesh-server-half-wp-gc2-2026-11-13));
   **past the cap is REFUSED (`room-full`) as an interim decision, superseded by D1 when WP-GC3
   lands.** **The 3-party CI call is BUILT** (`run.mjs --scenario mesh`, every directed leg proven
   under its sender's key, [call-service](../services/call-service.md#the-mesh-scenario-wp-gc2-2026-11-13)).
   **Client half BUILT 2026-11-13** (one leg per participant in the one call service, the
   `group_call` invite kind an old build drops, per-leg keys and transforms, WP-C11's decline and
   last-leave rules, the tile grid and the start control behind `group_calls_mode = mesh`:
   [calls](../frontend/modules/calls.md#group-calls---the-mesh-client-half-wp-gc2-2026-11-13)).
   Owed: the bench readings - 3-way audio and 3-way video on the Mi 9T and the iPhone 12, WebKit's
   receiver transforms per peer, CPU and fps with two receivers
   ([readings owed](../plan.md#readings-owed)).
3. **WP-GC3 - the Cloudflare Realtime SFU leg**: ~~the Q4 probe~~ **done 2026-11-13, PASS**
   ([sfu-e2ee-probe](../../../tools/sfu-e2ee-probe/README.md), dispatch `scheduled.yml` with
   `job=sfu-probe`); ~~the owner's one-off (a Realtime SFU app and its two secrets)~~ **done
   2026-11-13**: `CLOUDFLARE_SFU_APP_ID` / `CLOUDFLARE_SFU_APP_SECRET` in the `production` and
   `development` environments, wired OPTIONAL into chat-delivery-service by the probe's PR (dev's
   deploy and the probe read `DEV_CLOUDFLARE_SFU_*`, the ONLY pair `development` keeps - provisioned
   2026-11-13 from a new dev app that replaced the first - until the secret-name unification, [MIGRATION](../../../infrastructure/MIGRATION.md#3-github-secrets)). **The
   backend proxy BUILT 2026-11-16** (`/api/calls/sfu/*`, `call_relay = cloudflare`, core migration
   026, the pair's rows `warn`:
   [calls](../frontend/modules/calls.md#the-cloudflare-relay-wp-gc3-server-half-2026-11-16)). Left:
   the client's SFU leg on it (WP-GC4), the scheduled probe run through the proxy, and a five-way
   call on dev with `call_relay = cloudflare`.
4. **WP-GC4 - the relay setting (D2)**: **server half BUILT 2026-11-13** -
   `platform_config.call_relay` (`none` | `call-service`, core migration 023, `none` in production
   and on dev until the client's SFU leg ships), read at a group call's `initiate`; with
   `call-service`, a caller that declares `groupCallVersion >= 2` goes through the SFU FROM THE START (`mode: sfu` signed into the tokens - interim until WP-GC5); the
   SFU's atomic seat cap (2..=8), the sender's user id as each forwarded track's stream id, and the
   late joiner's renegotiation; a 5-party encrypted call through the SFU in CI
   ([calls](../frontend/modules/calls.md#the-relay-leg-wp-gc4-2026-11-13),
   [call-service](../services/call-service.md#the-relay-for-a-group-call-wp-gc4-2026-11-13)).
   `cloudflare` joined the setting with WP-GC3 (2026-11-16). **Client leg BUILT as a module 2026-11-16**
   (`services/callSfuLeg.ts`, `roomTokenMode` - a signed `cloudflare` mode is refused as
   `RoomTokenModeUnsupportedError`; the SFU `Joined { others }`; the CI's relayed call now runs through
   it - [calls](../frontend/modules/calls.md#the-apps-sfu-leg-wp-gc4-client-2026-11-16)).
   Owed: its `CallService` wiring once WP-GC6 merges, then `groupCallVersion` 2. A renegotiation scheduled while the peer holds a remote offer is retried
   once it is stable again (#3497); a reading under joins faster than a round trip is still owed.
5. **WP-GC5 - the switch (D1)**: on the participant past the cap, everyone opens the SFU leg,
   proves it, then closes the mesh legs; a rig row that FAILS when any frame crosses the SFU leg
   outside a transform, as `fault-transform-late` does for 1:1.
6. **Open point 4** is read against the B7 meter once WP-GC2 runs on the bench, not before.

**And one decision WP-C11 owed** (moved here 2026-11-11 from the review of #1997): **decided
2026-11-13 (reversible) - one block drops that member, never the call**
([calls](../frontend/modules/calls.md#group-calls---the-mesh-server-half-wp-gc2-2026-11-13)).

Delete this entry when WP-C11 ships; its rule goes to `durable-rules.md`, the mechanism to
[calls](../frontend/modules/calls.md).

**The readings the group-call build owes once it ships in a stable (carried here on 2026-11-14 from three reading entries deleted by the owner's rule that a reading of unshipped code is deleted: none of WP-GC1 to WP-GC4, #3489-#3502, is in `v1.6.12`).** File them as readings on the pre-release that first carries the group-call client, not before. (1) On dev with `group_calls_mode = mesh`, a three-way AUDIO call and a three-way VIDEO call between the Mi 9T, the iPhone 12 and a desktop browser, each started once from each phone: every participant hears and (video) sees the two others, the shield shows everywhere, each log has one `[leg ...]` line set per other participant with `E2E path check ... PASS`, a leave closes only that leg (`leg closed`) until the last, one member declining changes nothing for the two others. (2) The Mi 9T and the iPhone 12 each as a sender to two receivers for five minutes: each leg's `[CALL_REPORT]` (fps sent, ladder rung, `videoSendReduced`), the phone's CPU (Android `top`, Xcode gauge) and temperature; whether the cap of 3 in video holds. (3) On the iPhone 12 in the three-way call, the worker's `E2E receiver transformer #N` lines (one per participant), no `E2E key mismatch`, no `undecryptable`, both voices heard, each leg's `[CALL_REPORT]` (`callId/<user8>`) carrying decrypted frames: whether WebKit hands each receiver transform ITS options when one page holds two peer connections.

_2026-11-20, a pointer:_ WP-GC6's client half (`callRoomOccupancy.ts`) lives on the unmerged local branch `feat/group-calls-wp1`, behind `main`; the SFU leg's `CallService` wiring waits on it (see [the empty-room entry](group-call-empty-room-answer-and-outcome-less-ring.md)).
