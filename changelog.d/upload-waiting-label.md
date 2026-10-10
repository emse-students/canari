### Fixed - an attachment being sent no longer says "waiting for a connection" while online

The bubble now says `queued`, `repairing` or `retrying` from the outbox's typed hold reason, and "waiting for a connection" only after a transport failure or a known-offline link ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md)).
