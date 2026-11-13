## P2 - two vendored forks are behind upstream: `wry` 0.57.2 and `tauri-plugin-keystore` 2.1.0-alpha.2 (2026-11-11)

target: 1.10.0

Read by `vendored-upstream-report.sh` on 2026-11-11, from a working copy, against crates.io
([cicd](../cicd.md#a-vendored-fork-is-watched-for-upstream-releases-2026-10-21)):

- **`tauri-plugin-keystore`**: upstream published `2.1.0-alpha.2`; the fork in
  `frontend/src-tauri/patches/tauri-plugin-keystore` is `2.1.0-alpha.1`, with 1 `CANARI PATCH` hunk.
  This one became visible when the fork joined the watch under the pre-release rule.
- **`wry`**: upstream published `0.57.2`; the fork in `patches/wry` is `0.57.1`, with 11
  `CANARI PATCH` hunks (the Android main pipe, [mobile](../frontend/mobile.md#wry-main-pipe-patch)).

What upstream changed in each was not read here. Owed for each, in its own pull request:
1. Read upstream's changelog.
2. Take the published crate into `patches/<crate>` and re-apply the hunks.
3. Move the `=` pin in `frontend/src-tauri/Cargo.toml`.
4. Let CI build the Android artefact (and iOS for the keystore, which the notification extension
   reads).

The Monday `vendored-upstream` job stays red until both are done. Delete this entry then.
