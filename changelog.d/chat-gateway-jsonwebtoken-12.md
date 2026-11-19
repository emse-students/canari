### Changed - chat-gateway on jsonwebtoken 12, and its two audit ignores retired

The socket check keeps HS256 with the same expiry rules; an empty key now refuses every token. The new crate leaves `rsa` 0.9 and crypto-bigint 0.5, so chat-gateway carries no audit ignore ([cicd](docs/wiki/cicd.md#the-rust-ignores-live-in-cargoaudittoml-and-retire-themselves-too-2026-10-24)).
