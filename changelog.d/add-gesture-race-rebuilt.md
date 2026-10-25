### Fixed - an Add that loses a commit race is rebuilt, or the member is told

An invitation, a 1:1 creation and the pending-invitation sweep rebuild an Add refused `concurrent_commit` or `epoch_mismatch` once the race proved progress - re-checking before each pass that the commit which won did not remove the person, and filtering devices only on a tree confirmed current - and an invitation that added nobody now says why on screen ([mls-protocol](docs/wiki/protocols/mls-protocol.md#a-commit-that-loses-a-race-is-rebuilt-on-proven-progress-or-surfaced-2026-10-25)).
