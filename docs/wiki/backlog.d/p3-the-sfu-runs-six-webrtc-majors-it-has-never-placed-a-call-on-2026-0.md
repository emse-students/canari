## P3 - the SFU runs SIX webrtc majors it has never placed a call on (2026-08-27; re-read 2026-11-11: video through the SFU is what is left)

target: 1.8.0

Production calls do not touch the SFU: 1:1 audio and video run peer to peer with Cloudflare TURN
(`calls_mode` reads `audio_video` since `1.5.2`), and the School drops the outbound UDP the SFU needs,
so the SFU path cannot connect from production at all
([calls](../frontend/modules/calls.md#the-sfu-runs-six-webrtc-majors-it-has-never-placed-a-call-on-2026-08-27)).
The SFU is kept for the day the School opens UDP to it (D2,
[group calls](group-calls-p2p-mesh-up-to-4-audio-3-video-decided-2026-10-31.md)), and that day is when
this entry becomes P1.

**Done (D3, #2878, 2026-11-01):** `test-call-service-e2e` places an encrypted AUDIO call through the
SFU on every change that touches it - the binary, a throwaway coturn, two headless Chromes running
the app's own E2E worker, relay-only on both legs, renegotiation included; it passes on webrtc-rs
0.17 ([call-service](../services/call-service.md#the-end-to-end-call-in-ci)).

**Left:** VIDEO through the SFU in the same harness - the PLI relay and the VP8 clear header, the two
SFU paths no run has crossed. The 0.20 port stays a separate decision, and this call is what it
would have to pass.
