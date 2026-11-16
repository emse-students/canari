### Fixed - "server already unreachable" is logged once per spell, not once per request

A burst of stalled requests printed one identical line each; the line now appears once per unreachable spell and the closing "server reachable again" line carries the count of the others. See [offline and weak network](docs/wiki/frontend/offline-and-weak-network.md#21-server-already-unreachable-is-said-once-per-spell-2026-11-16).
