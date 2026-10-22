### Changed - key-group joins and departures share one lock, and `POST /mls/commit` is rate-limited per user

A key-group join's seat is written under a per-group lock that eviction also takes, after re-reading the entitlement, and social-service evicts again once a departure's roster write commits. The commit route answers `429` with its wait past 600 commits per user per minute; the client stops its sweeps until then, and warns when the server refuses a membership report ([channel-encryption](docs/wiki/protocols/channel-encryption.md#wp-21-and-the-gate-it-had-nowhere-to-live)).
