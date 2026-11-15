### Fixed

- Only an open live is announced: one ended before its start announcement was read is no longer pushed (to an empty audience when it was already purged, to everyone when its row was kept). The live and its audience are read from one snapshot ([lives](docs/wiki/services/lives.md)). It was also the cause of an intermittent test failure, and the test rig's shape for the announcement line matches the line again.
