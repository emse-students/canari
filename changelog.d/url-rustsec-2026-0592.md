### Fixed - `url` bumped to 2.5.9 in the three Rust lockfiles that resolve it (RUSTSEC-2026-0592)

The advisory (stack overflow in `Url::origin()` on nested `blob:` URLs, published 2026-11-20) was turning the `cargo audit` job, and so `CI passed`, red. Lockfile-only bump in `apps/call-service`, `apps/chat-gateway` and `frontend/src-tauri`; see [cicd](docs/wiki/cicd.md#the-audit-blocks-on-what-we-ship-2026-11-17).
