### Added - CI: a weekly watch for an upstream release past the vendored `tauri-plugin-websocket` fork

Job `vendored-upstream` of `scheduled.yml` turns red, naming the rebase, when crates.io's latest stable release passes the fork; an unreachable crates.io exits 75 ([cicd](docs/wiki/cicd.md#a-vendored-fork-is-watched-for-upstream-releases-2026-10-21)).
