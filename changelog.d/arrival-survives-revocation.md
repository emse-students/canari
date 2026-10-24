### Fixed - a revoked device no longer erases its owner's arrival in a group conversation

The enrolment copies an earlier device admission onto the membership interval (migration 033, with a backfill), so a late-enrolled member's next device keeps its history; `for` is decided against the caller's current interval ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#a-new-member-receives-nothing-from-before-their-arrival-decided-by-the-user-2026-10-21)).
