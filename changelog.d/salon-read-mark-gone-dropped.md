### Fixed - a read mark owed for a deleted salon is dropped instead of retried at every load

The server names the answer (`404 CHANNEL_NOT_FOUND`) and the client drops the mark on it, saying so once ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md)).
