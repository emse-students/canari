### Changed - the Tauri biometric, websocket and log plugins move to 2.4.1, 2.5.0 and 2.10.0, JS and Rust together

Dependabot moves only the JS half, so these three arrived red on the parity guard; the crates are updated in the same change and `cargo check` compiles. The recipe is in [cicd](docs/wiki/cicd.md#a-tauri-plugin-bump-is-two-halves-and-the-crate-half-can-be-a-runtime-bump-2026-10-08).
