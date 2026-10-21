### Fixed - the dependency audit is green again (rustls-webpki 0.103.16, webpki-roots 1.0.10)

RUSTSEC-2026-0381/0382/0383 landed after the last green run; three lockfiles move to the patched versions, and the one `webpki-roots` 0.26 copy that sqlx and tokio-tungstenite pin is a dated, reasoned ignore ([cicd](docs/wiki/cicd.md)).
