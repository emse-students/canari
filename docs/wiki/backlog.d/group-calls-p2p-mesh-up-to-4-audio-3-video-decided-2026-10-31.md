## Group calls go peer to peer in a MESH up to 4 in audio and 3 in video, a relay SFU beyond (owner decision D-A, 2026-10-31, not built - feeds WP-C11)

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
2. ~~**Which SFU** (WP-C4).~~ **Decided, D2 above: both, one setting.** What D2 still owes is the
   fact Q4 left unverified - whether Cloudflare's raw SFU forwards transformed frames
   ([calls-revival-plan](../frontend/modules/calls-revival-plan.md#14-probes-of-2026-10-16-clients)) -
   and it is the first step of WP-GC3 below, before any code is written against it.
3. **Keys in a mesh.** Today's media keys are per DIRECTION of a 1:1 call (`utils/callKeys.ts`,
   `<callId>|<role>`); a mesh needs one key per sender, derived the same way from the group's MLS
   exporter. The SFU leg needs the same per-sender keys, so this is settled once for both.
4. **TURN volume.** A relayed mesh pays Cloudflare TURN per pair, so a 4-way mesh with every leg
   relayed is 12 streams of egress: read against the B7 budget
   ([calls](../frontend/modules/calls.md#the-turn-budget-reads-cloudflares-meter-b7)).

### The next work packages, in order (not started)

Each is one pull request or more; none is built by the D3 change.

1. **WP-GC1 - per-sender media keys** (open point 3): one key per sender from the group's MLS
   exporter, the worker keyed with one send key and N-1 receive keys. Both the mesh and the SFU
   leg need it, so it comes first.
2. **WP-GC2 - the mesh**: `call-service`'s peer-to-peer room grows from two seats to the cap (4 in
   audio, 3 in video) with addressed signalling (`to`/`from` per frame), and the client holds one
   peer connection per other participant, each armed as the 1:1 one is.
3. **WP-GC3 - the Cloudflare Realtime SFU leg**: first the Q4 probe (do transformed frames cross
   the raw SFU), then the owner's one-off (a Realtime SFU app and its two secrets), then the backend
   proxy of the sessions/tracks API and the client's SFU leg on it.
4. **WP-GC4 - the relay setting (D2)**: one server-side setting (`cloudflare` | `call-service`)
   read where the call starts, and the client's SFU leg against `call-service`'s protocol too - the
   one `apps/call-service/e2e/page.ts` already speaks. A new platform setting is a migration, so it
   waits for the owner's yes.
5. **WP-GC5 - the switch (D1)**: on the participant past the cap, everyone opens the SFU leg,
   proves it, then closes the mesh legs; a rig row that FAILS when any frame crosses the SFU leg
   outside a transform, as `fault-transform-late` does for 1:1.
6. **Open point 4** is read against the B7 meter once WP-GC2 runs on the bench, not before.

Delete this entry when WP-C11 ships; its rule goes to `durable-rules.md`, the mechanism to
[calls](../frontend/modules/calls.md).
