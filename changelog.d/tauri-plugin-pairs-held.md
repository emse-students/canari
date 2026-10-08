### Changed - the three red Tauri plugin bumps are held until the tauri 2.12 / tao 0.37 rebase

`plugin-http` 2.8, `plugin-opener` 2.7 and `plugin-store` 2.5 each need crates that pull `tauri 2.12` and `wry 0.57`, which drop the vendored `tao` patch; the guard was right to refuse them ([cicd](docs/wiki/cicd.md#a-tauri-plugin-bump-is-two-halves-and-the-crate-half-can-be-a-runtime-bump-2026-10-08)).
