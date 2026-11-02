### Fixed - a message deleted while a device was away stayed on that device

A deletion whose message was stored but not on screen, or not yet received (both arriving in one catch-up), was dropped; it now tombstones the stored row or is kept until its message arrives ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#deletion-purges)).
