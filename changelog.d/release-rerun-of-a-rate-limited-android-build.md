### Changed - the 1.8.1 stable's Android build was rescued by a rerun of the failed job

The build hit a Maven Central `429 Too Many Requests` once; the failed job was rerun and passed, with every gate run and none skipped (not an admin bypass). The dependency on a third-party rate limit at build time is [planned](docs/wiki/backlog.d/p2-a-release-build-must-not-depend-on-a-third-party-rate-limit.md).
