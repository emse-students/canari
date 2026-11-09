### Fixed - the dependency audit tolerates the unmaintained `pin-utils` warning in call-service

RUSTSEC-2026-0441 (status warning only) arrives through webrtc 0.17 -> nix 0.26 and no lockfile bump removes it; it is ignored until the webrtc 0.21 port, with a 2027-01-31 re-examination ([cicd](docs/wiki/cicd.md#the-rust-ignores-live-in-cargoaudittoml-and-retire-themselves-too-2026-10-24)).
