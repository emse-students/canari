### Fixed - a phone no longer walks every member for history older than the group itself

A member whose memory reaches below the group's creation no longer reports a coverage shortfall, and the asker no longer walks on one. The SQLite row now keeps the group's start ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#a-shortfall-that-predates-the-group-is-not-a-shortfall-2026-10-26)).
