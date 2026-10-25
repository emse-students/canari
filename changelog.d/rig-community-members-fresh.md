### Fixed - the salon rows reach their premise, and cleanup knows their communities

The salon runner now:
- waits for the member row it acts on;
- closes the community panel it opened;
- mints lower-case salon names.

`cleanup.mjs` reads its community allowlist from `debris.mjs`, which now names the salon runner's `RM<n>-` communities. Both lists are pinned with controls ([cross-client-testing](docs/wiki/cross-client-testing.md), [backlog](docs/wiki/backlog.md)).
