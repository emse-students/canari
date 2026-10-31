### Changed - the call SFU runs on webrtc 0.21

The media plane was rewritten onto the new trait-based API (one local track per subscriber, gated on negotiation and DTLS, keyframe requests through an RTCP interceptor), the `time` pin is gone and `RUSTSEC-2026-0387` lost its DTLS edge. No client uses the SFU yet, so what must be read is a p2p call on both phones and, before the SFU is used, a late-joiner group call ([calls](docs/wiki/frontend/modules/calls.md#the-webrtc-021-port-built-2026-10-27)).
