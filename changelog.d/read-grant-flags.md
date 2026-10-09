### Fixed - a reader who sees a post only through a read grant is no longer offered "Republier" or a poll vote

The server now computes `canRepublish` and the new `canVote` with the same grant-free predicate the republish and vote endpoints enforce ([profiles-and-access](docs/wiki/profiles-and-access.md)); the poll shows read-only.
