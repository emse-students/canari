### Fixed - a salon message, edit, reaction, pin or vote made offline is sent on the reconnect, and a DM read mark survives a kill

The server answers a repeated salon send with the row it holds (migration 088), so a lost answer, a Retry or a resumed page life never duplicates; a DM read receipt is owed from the instant it is decided and drained at the next boot ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md#16-wp-off-3-and-wp-off-4-built-a-salon-write-waits-for-the-link-and-a-repeat-is-one-row-2026-10-17)).
