### Changed - the call SFU runs on webrtc 0.21

The media plane was rewritten onto the new trait-based API (one local track per subscriber fed from a broadcast, keyframe requests through an RTCP interceptor), the `time` pin is gone and `RUSTSEC-2026-0387` lost its DTLS edge. Calls stay held off in production, and a device call is still owed ([calls](docs/wiki/frontend/modules/calls.md#the-webrtc-021-port-built-2026-10-27)).
