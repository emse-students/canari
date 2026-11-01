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

**Open design points** (to settle in WP-C11 before code):

1. **The mesh-to-SFU switch.** What happens when a 5th audio participant (a 4th in video) joins a
   live mesh: every participant renegotiates onto the SFU mid-call, or the call is refused / drops
   video. A switch must keep the E2E frame transforms in the path - each transform assigned in the
   task that creates its sender ([durable-rules](../durable-rules.md#calls-and-their-record---call-service)) -
   and must not leave a window where media flows around them.
2. **Which SFU** (WP-C4): whether the raw Cloudflare SFU forwards transformed frames is still
   unverified ([calls-revival-plan](../frontend/modules/calls-revival-plan.md#14-probes-of-2026-10-16-clients), Q4).
3. **Keys in a mesh.** Today's media keys are per DIRECTION of a 1:1 call (`utils/callKeys.ts`,
   `<callId>|<role>`); a mesh needs one key per sender, derived the same way from the group's MLS
   exporter.
4. **TURN volume.** A relayed mesh pays Cloudflare TURN per pair, so a 4-way mesh with every leg
   relayed is 12 streams of egress: read against the B7 budget
   ([calls](../frontend/modules/calls.md#the-turn-budget-reads-cloudflares-meter-b7)).

Delete this entry when WP-C11 ships; its rule goes to `durable-rules.md`, the mechanism to
[calls](../frontend/modules/calls.md).
