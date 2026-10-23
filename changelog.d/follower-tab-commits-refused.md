### Fixed - a follower browser tab no longer sends commits its leader tab cannot follow

Only the leader tab commits; a follower refuses before staging, and a commit whose checkpoint throws is kept for a settle instead of being cleared ([mls-protocol](docs/wiki/protocols/mls-protocol.md)).
