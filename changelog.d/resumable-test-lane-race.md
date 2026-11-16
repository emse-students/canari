### Fixed - the resumable-upload test no longer assumes which of two racing answers lands first

`main` failed once because a test expected part 3 to wait for the next round, while the second lane may take it before a lost answer ends the round; the test now proves "never sent twice" by the PUT count ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#139-a-queued-file-over-one-request-body-resumes-and-its-figure-never-goes-back-2026-11-16)).
