### Fixed - a group joined in the background gets its conversation row at cold start, and its queued messages are no longer lost

The redelivered Welcome and the push-cache merge now write and announce the missing row, and the epoch-gap healer no longer replays commits past frames still queued for that group ([mls-recovery-ladder](docs/wiki/protocols/mls-recovery-ladder.md)).
