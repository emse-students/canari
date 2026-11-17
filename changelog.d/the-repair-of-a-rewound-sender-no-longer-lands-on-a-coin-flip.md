### Fixed - the repair of a device that holds messages it cannot read no longer depends on which member the server picks

The repair stopped on the first member that held the same gap, so it reached the one member holding the messages about one time in three. Now that member says it cannot help and is skipped until the repair lands ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#the-fix-the-walk-advances-on-an-answer-built-2026-11-17)).
