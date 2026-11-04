## P2 - pull-request CI never compiles the iOS Swift, so a Swift error first surfaces at a release cut (found 2026-11-04)

`ci.yml` runs no iOS job: `ios.yml` is reached only by `release.yml` (`workflow_call`) and by hand
(`workflow_dispatch`, `publish: false`, the compile check). A pull request that edits a Swift plugin
(`frontend/src-tauri/plugins/*/ios`, `frontend/src-tauri/patches/*/ios`) or `frontend/src-tauri/gen/apple`
goes green on `CI passed` without a single Swift file compiled, and nothing on this Windows
workstation compiles Apple code either - so a type error, a missing `import` or an unavailable API
first fails on the pre-release, after the merge, where it blocks every other change behind it.
Today the only gate is remembering to dispatch `ios.yml` per branch, which is a human queue.

**The gate that lifts it:** an iOS COMPILE-ONLY job in `ci.yml`, run when a pull request touches
`frontend/src-tauri/**/ios/**`, `frontend/src-tauri/gen/apple/**` or any `*.swift` / `*.mm`, that
builds the app for the simulator or with `CODE_SIGNING_ALLOWED=NO` - no signing secret, no export,
no upload - and feeds `CI passed`. Mechanism and the four-visible-workflows rule it must respect:
[cicd](../cicd.md).
