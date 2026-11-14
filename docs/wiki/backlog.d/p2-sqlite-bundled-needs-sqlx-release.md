## P2 - the bundled SQLite in the app is 3.46 (RUSTSEC-2026-0459), and only an sqlx release can move it

target: 1.10.0

`frontend/src-tauri` links libsqlite3-sys 0.30.1 with `bundled`, through sqlx 0.8.6 (directly, and
through tauri-plugin-sql 2.6.0). RUSTSEC-2026-0459 (CVE-2026-119375, 2026-10-30) is fixed only in
libsqlite3-sys >= 0.39.0 (SQLite 3.54). Measured 2026-11-09: sqlx-sqlite 0.8.6 requires `^0.30.1`,
0.9.0 (the newest) `>=0.30.1, <0.38.0`, sqlx `main` pins `0.37.0`, and tauri-plugin-sql 2.6.0 and
3.0.0-alpha.3 both require `sqlx ^0.8`. No lockfile change can take the fix, so the advisory is
ignored in `frontend/src-tauri/.cargo/audit.toml`, whose entry carries the reachability argument
(the only copy, [cicd](../cicd.md#the-rust-ignores-live-in-cargoaudittoml-and-retire-themselves-too-2026-10-24)).

**Lifted by:** an sqlx release accepting libsqlite3-sys >= 0.39 AND a tauri-plugin-sql release on
that sqlx; then bump both, delete the ignore and this file. The `Every ignored Rust advisory is still
reported` step does NOT watch this condition (the advisory stays reported until the bump), so it is
re-checked by hand.

**Re-examine by 2027-01-31.** If no such release exists by then, take the fallback: a
`[patch.crates-io]` of libsqlite3-sys 0.30.x pointing at a fork that replaces only the bundled
`sqlite3.c` / `sqlite3.h` with the 3.54.x amalgamation (the C API is backward compatible; the 0.30
pregenerated bindings simply do not expose the new symbols). It clears the advisory for real at the
cost of a vendored fork retired by hand, and it owes an Android and an iOS build plus a phone
reading of the message store before it merges.
