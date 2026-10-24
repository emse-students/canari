### Added - the test rig builds the phone's debug APK for the dev estate, and an old client from a tag

`a1apk.mjs` plans the build from the estate: dev gets no `adb reverse`, no local-estate overlay and dev's identity provider; `--build-only --ref v1.4.0` builds an old client in its own worktree ([harness README](tools/cross-client-harness/README.md#the-target-the-local-estate-or-dev-and-production-is-refused)).
