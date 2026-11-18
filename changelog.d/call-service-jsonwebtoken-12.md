### Changed - call-service on jsonwebtoken 12, and its `rsa` audit ignore retired

The socket and room-token checks keep HS256 with the same expiry rules; an empty key now refuses every token. The new crate leaves `rsa` 0.9, and crypto-bigint 0.5 stays on the webrtc dtls edge alone ([cicd](docs/wiki/cicd.md#the-rust-ignores-live-in-cargoaudittoml-and-retire-themselves-too-2026-10-24)).
