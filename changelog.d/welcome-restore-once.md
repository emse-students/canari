### Fixed - a burst of Welcomes no longer restores every conversation once per Welcome

Restores now run one at a time with at most one queued, so a new device joining 80 groups restores twice instead of 80 times; a sign-out retires the queue, so a restore never runs as the account that left ([performance-audit](docs/wiki/frontend/performance-audit-2026-10-12.md#finding-8---built-2026-10-18-draft-pr-perfwelcome-restore-once)).
