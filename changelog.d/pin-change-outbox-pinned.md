### Changed - the outbox re-seal of a PIN change is pinned for every row kind, and its stale backlog rows are closed

A queued text, reaction and attachment are now each tested across a PIN change, with a flush racing the pass ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#137-the-file-leaves-the-outbox-row-bytes-in-indexeddb-a-key-in-the-row-2026-10-11)).
