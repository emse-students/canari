### Fixed - the Android release build is less likely to hit Maven Central's rate limit

The Gradle cache a release restored was filled by a debug-only compile, so it lacked what only a release links and the build hit Maven Central's `429` anyway. CI now runs the real release chain (minus rust), online then `--offline`, and the cache key moves so it is saved afresh; the next release's log is the proof ([cicd](docs/wiki/cicd.md#the-android-release-build-resolves-from-a-cache-ci-completes-and-proves-offline-2026-11-25)).
