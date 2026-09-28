### Security - Graine v2's primitives exist: a bound header, a per-session signature, an endorsement that commits to the seed

Pure additions, wired to nothing yet: the Ed25519 half lives in `mls-core` (WASM and Tauri), and the encodings in `graineV2.ts` and its native mirror. Shared vectors and a frozen fixture hold the two sides together ([channel-encryption §21.2](docs/wiki/protocols/channel-encryption.md#212-the-v2-primitives-wp-g2-2---written-tested-wired-to-nothing)).
