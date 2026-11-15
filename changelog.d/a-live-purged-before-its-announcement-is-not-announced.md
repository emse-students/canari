### Fixed

- A live ended and purged before its start announcement was read is no longer pushed to an empty audience: the live and its audience are read from one snapshot, and a live that is gone is not announced ([lives](docs/wiki/services/lives.md)). It was also the cause of an intermittent test failure.
