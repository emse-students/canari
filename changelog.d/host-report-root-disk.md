### Added - the daily host report watches the root disk

The `hosts` job now prints the production host's root filesystem with our consumers (backups, Docker, runner leftovers) and turns red at 85 %; the hand cleanup of 2026-10-24 and what is safe to delete are written down ([host-updates](docs/wiki/infrastructure/host-updates.md#the-root-disk)).
