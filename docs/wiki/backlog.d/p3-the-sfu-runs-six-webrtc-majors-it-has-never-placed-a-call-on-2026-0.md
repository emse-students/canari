## P3 - the SFU runs SIX webrtc majors it has never placed a call on (2026-08-27; a check before production calls)

Calls are compiled into every build since #2299 and held off in production by the server's `calls_mode`; the SFU is UNVERIFIED, not broken, and it becomes P1 before `calls_mode` opens a relay-path call in production. What settles it is one
relay-path call, two peers, audio and video - planned BY HAND until D3 below made it a CI job (the in-process half of it runs in CI since 2026-10-09: `apps/call-service/tests/relay_path.rs`)
([calls](../frontend/modules/calls.md#the-sfu-runs-six-webrtc-majors-it-has-never-placed-a-call-on-2026-08-27)).

**D3 (owner, 2026-11-01): the call is a CI job, not a by-hand session.** The SFU is kept working for
the day the School opens UDP to it (D2, [group calls](group-calls-p2p-mesh-up-to-4-audio-3-video-decided-2026-10-31.md)),
and `test-call-service-e2e` places an encrypted audio call through it on every change that touches
it - the binary, a throwaway coturn, two headless Chromes running the app's own E2E worker,
relay-only on both legs ([call-service](../services/call-service.md#the-end-to-end-call-in-ci)).
It passes on webrtc-rs 0.17 with no upgrade. **Still owed before this entry closes:** video through
the SFU (the PLI relay and the VP8 clear header), added to the same harness; the 0.20 port stays a
separate decision, and this call is what it would have to pass.
