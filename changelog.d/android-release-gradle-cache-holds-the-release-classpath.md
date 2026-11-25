### Fixed - the Android release build no longer goes to Maven Central for its dependencies

The Gradle cache a release restored was filled by a debug-only compile, so it lacked the release classpath and the build hit Maven Central's `429` anyway. CI now also resolves the release variant, online then `--offline`, and the cache key moves so it is saved afresh ([cicd](docs/wiki/cicd.md#the-android-release-build-resolves-from-a-cache-ci-completes-and-proves-offline-2026-11-25)).
