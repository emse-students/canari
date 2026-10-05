### Removed - the `mls-wasm-stub` Vite plugin, which changed nothing in any build

Both native bundles carry the WASM binary because the backup envelope uses it on every platform. The stub never removed it. See [mobile](docs/wiki/frontend/mobile.md#a-native-build-carries-the-wasm-binary-for-the-backup-envelope-2026-10-04).
