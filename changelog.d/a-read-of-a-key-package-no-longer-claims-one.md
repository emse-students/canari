### Fixed - asking about a device's KeyPackage no longer spends one

Adding one device used to claim a one-time KeyPackage from every device of its account, and a device checking whether it was itself published claimed one of its own each time it asked. On 2026-11-06 this emptied five pools in two minutes (430 empty-pool serves in an hour). The adding paths now claim the one device they add, and the self-check reads with `?peek=1` ([key-package-pool](docs/wiki/protocols/key-package-pool.md#a-read-is-not-a-claim---the-empty-pool-storm-of-2026-11-06)).
