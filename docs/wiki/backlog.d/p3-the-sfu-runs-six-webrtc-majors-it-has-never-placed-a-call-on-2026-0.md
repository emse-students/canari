## P3 - the SFU runs SIX webrtc majors it has never placed a call on (2026-08-27; re-read 2026-11-11: video through the SFU is what is left)

target: 1.9.2

Production calls do not touch the SFU: 1:1 audio and video run peer to peer with Cloudflare TURN
(`calls_mode` reads `audio_video` since `1.5.2`), and the School drops the outbound UDP the SFU needs,
so the SFU path cannot connect from production at all
([calls](../frontend/modules/calls.md#the-sfu-runs-six-webrtc-majors-it-has-never-placed-a-call-on-2026-08-27)).
The SFU is kept for the day the School opens UDP to it (D2,
[group calls](../decisions/group-calls-p2p-mesh-up-to-4-audio-3-video-decided-2026-10-31.md)), and that day is when
this entry becomes P1.

**Done (D3, #2878, 2026-11-01):** `test-call-service-e2e` places an encrypted AUDIO call through the
SFU on every change that touches it - the binary, a throwaway coturn, two headless Chromes running
the app's own E2E worker, relay-only on both legs, renegotiation included; it passes on webrtc-rs
0.17 ([call-service](../services/call-service.md#the-end-to-end-call-in-ci)).

**Left:** VIDEO through the SFU in the same harness - the PLI relay and the VP8 clear header, the two
SFU paths no run has crossed. The 0.20 port stays a separate decision, and this call is what it
would have to pass.

**The webrtc 0.21 port exists and must be redone (2026-11-14).** PR #2619, branch `deps/webrtc-0.21`
(kept; green on 2026-11-13, closed unmerged), moved `apps/call-service` from `webrtc` 0.17 to 0.21. It
conflicts in `src/main.rs` since #3497 rewrote the SFU for group calls, so it is a port to redo on
top of that SFU, not a rebase. What it carried: 0.21 is a sans-I/O rewrite, so the media plane is
ported, not bumped.

- One `PeerConnectionEventHandler` trait object per peer (`SfuPeerHandler`) instead of closures; track
  publishing spawned off the driver task; end of gathering is a state, still sent as the
  empty-candidate marker.
- A local track binds to ONE connection and refuses a packet whose SSRC, payload type or extension ids
  are not its leg's: new `src/forward.rs`, one local track per subscriber fed from a `broadcast` of the
  publisher's RTP, rewritten to the leg's SSRC, payload type and negotiated extensions.
- Inbound RTCP no longer reaches the application: `RtcpForwarderInterceptor` marks PLI/FIR so a
  subscriber's keyframe request still reaches the publisher.
- `with_udp_addrs(["0.0.0.0:0"])`; TURN stays UDP only (0.21 skips TCP/TLS URLs), so the School's
  no-outbound-UDP blocker is unchanged.
- `tests/relay_path.rs` rewritten for the new client API, the TURN server being the `turn` 0.17 crate
  as a dev-dependency (0.21 has only a client); a second test links `forward.rs` and runs publisher,
  SFU, viewer over relay-only peers.
- The `time` pin removed (rcgen 0.14.10); `RUSTSEC-2026-0387` loses its reachable DTLS edge.
- Gates were green: fmt, clippy `-D warnings`, `cargo test`, `cargo audit`.

Never verified: a Tier A call on the Mi 9T and the iPhone (a browser's SDP, renegotiation with several
tracks, header-extension ids differing between legs, H264 fmtp matching, Cloudflare TURN as production
configures it); header extensions are kept only when the leg negotiated the same id, and nothing proves
a real browser's ids name the same extension on both legs.

**The port's review leftovers** (its own entry, never merged), each to re-check against the group-call
SFU: a dead track is never removed from `Room.tracks`, so a later joiner is subscribed to a publisher
that left; a Join racing `publish_track` can subscribe the same peer twice to one track (the peer is
inserted in `room.peers` before it takes the `tracks` lock); gathering is IPv4 only, an IPv6-only path
is untested.
