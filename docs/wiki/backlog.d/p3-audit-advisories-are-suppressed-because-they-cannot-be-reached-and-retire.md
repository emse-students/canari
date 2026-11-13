## P3 - audit advisories are suppressed because they cannot be reached, and retire themselves

target: 1.8.0

Five advisories (`GHSA-vcc3-ghjq-m6fr`, `GHSA-qr28-fpjm-wq7f`, `GHSA-528h-pc64-c93x`, `GHSA-hqr4-qq8f-hg3x`,
`GHSA-mjw6-4jj6-33hc`) are ignored on the `minio > ...` edge of media-service; minio 8.0.7 is still the
latest (2026-10-10). **Nothing is polled by hand any more (2026-10-10):** the premises step of
`code-analysis.yml` audits the tree WITHOUT the ignores (`ignored-advisories-still-reported.sh`, self-tested)
and FAILS the day an ignored id is no longer reported, naming the ignore, its premise assertion
(`.github/scripts/stream-json-premise.sh`) and this entry as what to delete. The reasoning is in
[cicd](../cicd.md#five-audit-advisories-are-suppressed-on-one-edge-of-media-service-and-why-each-is-unreachable).

`RUSTSEC-2026-0387` (crypto-bigint 0.5.5) is ignored in all four Rust trees since 2026-10-24, each
with its statement in `.cargo/audit.toml`; REACHABLE IN CODE in call-service's DTLS only. Lifted by the
webrtc 0.21 port and p256 0.14 reaching jsonwebtoken and openmls_rust_crypto; the cargo retirement
step fails when it is gone ([cicd](../cicd.md#the-rust-ignores-live-in-cargoaudittoml-and-retire-themselves-too-2026-10-24)).
