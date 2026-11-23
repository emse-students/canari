## P2 - group calls: what is left after the mesh client half and the SFU leg module

target: 1.8.0

The design and what was built are in [the decision record](../decisions/group-calls-p2p-mesh-up-to-4-audio-3-video-decided-2026-10-31.md) (WP-GC2 to WP-GC5). Left: (1) the bench readings of the mesh client, 3-way audio and 3-way video on the Mi 9T and the iPhone 12, WebKit's receiver transforms per peer, CPU and fps with two receivers; (2) the SFU leg's `CallService` wiring (WP-GC4 client, `services/callSfuLeg.ts`) once WP-GC6 merges, then `groupCallVersion` 2, the scheduled probe through the proxy, a five-way call on dev with `call_relay = cloudflare`, and a reading under joins faster than a round trip; (3) WP-GC5, the mesh-to-SFU switch on the participant past the cap, with a rig row that FAILS when a frame crosses the SFU leg outside a transform; (4) open point 4, read against the B7 meter once WP-GC2 runs on the bench.
