### Fixed - a joiner whose Welcome is on its way waits for it, and a frame read twice is no longer called damaged

A device that a member's commit reached before its Welcome no longer asks every member to re-add it, and the re-fetch after the Welcome reports a frame it already read as a duplicate, not as damage ([mls-protocol](docs/wiki/protocols/mls-protocol.md#a-joiner-whose-first-frame-beats-its-welcome-waits-for-it-dup-2-2026-10-25)).
