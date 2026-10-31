## P3 - the SFU runs SIX webrtc majors it has never placed a call on (2026-08-27; a check before production calls)

Calls are compiled into every build since #2299 and held off in production by the server's `calls_mode`; the SFU is UNVERIFIED, not broken, and it becomes P1 before `calls_mode` opens a relay-path call in production. What settles it is one
relay-path call, two peers, audio and video, TURN as production configures it, taken by hand (the in-process half of it runs in CI since 2026-10-09: `apps/call-service/tests/relay_path.rs`)
([calls](../frontend/modules/calls.md#the-sfu-runs-six-webrtc-majors-it-has-never-placed-a-call-on-2026-08-27)).
