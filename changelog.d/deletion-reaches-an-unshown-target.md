### Fixed - a message deleted while a device was away stayed on that device

A deletion, an edit or a reaction whose message was stored but not on screen now reaches the stored row; one whose message has not arrived yet is kept in a local store of its own and applied, by the message's author only, when the message arrives - including across a restart and through the archive replay ([history-reconciliation](docs/wiki/protocols/history-reconciliation.md#mutations-that-arrive-before-their-message)).
