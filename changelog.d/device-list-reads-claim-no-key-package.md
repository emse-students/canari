### Fixed - reading the device list no longer spends one-time KeyPackages

The settings device count, the device panel, the new-device notices and the Welcome fan-out read an account's device list with `?peek=1`, which claims nothing; only group creation and the Graine admission claim, and a claim is never shared between two callers. Mechanism: [key-package-pool](docs/wiki/protocols/key-package-pool.md#a-read-is-not-a-claim---the-empty-pool-storm-of-2026-11-06).
