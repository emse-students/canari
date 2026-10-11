### Fixed - a queued attachment no longer lives inside the outbox row

The bytes of a queued file now sit in the app's own IndexedDB, encrypted under a per-entry key kept in a row of under 1 KB, so a 13 MB attachment no longer crosses the Android SQL bridge three times per send; a file lost by the platform shows the existing error card instead of a silent failure, and a full device says so. Design and crash windows in [offline-and-weak-network 13.7](docs/wiki/frontend/offline-and-weak-network.md).
