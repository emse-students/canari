### Fixed - a Welcome sent again is no longer published twice

A re-send of the same Welcome waits for the delivery already running and publishes nothing if it ran, so a new device no longer receives one Welcome live twice (migration 058, [mls-protocol](docs/wiki/protocols/mls-protocol.md)).
