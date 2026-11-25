### Changed - the 1.8.1 stable's Android build was rescued by a rerun of the failed job

The build hit a Maven Central `429 Too Many Requests` once; the failed job was rerun and passed, with every gate run and none skipped (not an admin bypass). The dependency on a third-party rate limit at build time is [closed](docs/wiki/cicd.md#the-android-release-build-resolves-from-a-cache-ci-completes-and-proves-offline-2026-11-25).
