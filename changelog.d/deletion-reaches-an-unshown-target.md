### Fixed - a message deleted while a device was away stayed on that device

A deletion, an edit or a reaction whose message was stored but not on screen, or not yet received, was dropped; each now reaches the stored row or waits for its message, a re-delivered message no longer overwrites a stored one, and two devices that differ only on a deletion now converge ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#deletion-purges)).
