### Fixed - GAP-2 counts the queue's repeat of an injected frame as its classification

A replayed row this device already took in is stopped at the queue (`arrived twice`) before the MLS layer could call it a duplicate, and that line names no group; GAP-2 now matches it by the injected id ([cross-client-testing](docs/wiki/cross-client-testing.md)).
