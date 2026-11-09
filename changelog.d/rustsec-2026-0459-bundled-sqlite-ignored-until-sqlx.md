### Security - RUSTSEC-2026-0459 (bundled SQLite, crafted `-wal`) ignored in `frontend/src-tauri`, time-boxed to 2027-01-31

No released sqlx accepts the patched libsqlite3-sys 0.39, and the vulnerable path needs a crafted database pair inside the app sandbox; the reachability argument and the lift condition are in [cicd](docs/wiki/cicd.md#the-rust-ignores-live-in-cargoaudittoml-and-retire-themselves-too-2026-10-24) and [backlog](docs/wiki/backlog.d/p2-sqlite-bundled-needs-sqlx-release.md).
