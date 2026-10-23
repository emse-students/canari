### Fixed - a follower browser tab no longer sends commits its leader tab cannot follow

Only the leader tab commits, joins or creates a group, and the member is told to act from the main tab. A commit whose checkpoint stored nothing is cleared; one whose checkpoint may have landed is kept for a settle ([mls-protocol](docs/wiki/protocols/mls-protocol.md)).
