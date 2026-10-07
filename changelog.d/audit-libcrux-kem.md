### Fixed - the Rust audit no longer fails on libcrux-kem's two hybrid-KEM advisories

They are not reachable under Canari's X25519 cipher suite and the fix is blocked upstream until `openmls_libcrux_crypto` takes `hpke-rs-libcrux` 0.8; recorded with their lift condition in the two `audit.toml` files ([mls-protocol](docs/wiki/protocols/mls-protocol.md)).
