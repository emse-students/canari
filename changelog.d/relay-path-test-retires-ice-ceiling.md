### Changed - the SFU's relay path is tested in CI, so WebRTC dependency updates no longer wait for a human

`apps/call-service/tests/relay_path.rs` puts two relay-only peers through an in-process TURN server and carries a data-channel message and an SRTP packet across, so the dependency ceiling stops refusing `webrtc`, `ice`, `turn`, `stun` and `sdp` updates ([cicd](docs/wiki/cicd.md)).
