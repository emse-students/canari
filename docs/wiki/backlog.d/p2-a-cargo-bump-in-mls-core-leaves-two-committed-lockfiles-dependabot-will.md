## P3 - `frontend/` holds three Cargo lockfiles that one `mls-core` bump must all move: one workspace

target: 1.7.3

_2026-11-20: moved to 1.7.2 when 1.7.1 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

_2026-11-17: moved to 1.7.1 by the owner's 2026-11-17 scope cut ([decisions](owner-decisions-of-2026-11-17.md))._

`mls-wasm` and `src-tauri` carry committed locks and depend on `mls-core` by path, so Dependabot's single pull request (against `mls-core/Cargo.toml`) is incomplete by construction. **BUILT 2026-10-19 (WP-RUST-LOCK-AUTOMERGE), owed what only a live run can show:** `cargo-lock-refresh.sh` completes it on a new branch opened by the `canari-auto-merge` App, and `arm-auto-merge.yml` arms only that, against a closed allowlist ([cicd](../cicd.md#a-dependabot-cargo-bump-that-is-incomplete-by-construction-is-completed-and-merged-wp-rust-lock-automerge-2026-10-18), with the threat model). **Owed:** the first real run on a Dependabot `mls-core` pull request (or a dispatch while one is open), read end to end - the refresh pull request opened, ARMED (the one unmeasured fact: that the API resolves the App's commits to `canari-auto-merge[bot]`; if not, it is refused, the safe direction), and merged on `CI passed`. **The structural remedy is still not done:** one cargo workspace with ONE `Cargo.lock` for `frontend/`, which restructures a Tauri build this workstation can only compile.

**Re-triaged 2026-11-14 (owner: every owed reading is read or deleted, never left waiting).** The live run is no longer owed as a reading: no Dependabot `mls-core` pull request has opened in four weeks (every cargo one named `call-service` or `chat-gateway`), nothing can provoke one, `cargo-lock-refresh.test.sh` pins the refresh and its refusals against a stateful fake `gh`, and the one unmeasured fact (the App's commits resolved to `canari-auto-merge[bot]`) fails toward a refusal. What stays open is the structural remedy above: one cargo workspace with ONE `Cargo.lock` for `frontend/`.
