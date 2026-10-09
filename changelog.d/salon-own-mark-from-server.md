### Fixed - a salon's unread badge came back after every reload, its read mark never posted

A load restored the reader's own salon mark from disk and kept it over the server's lower one, so reading moved nothing and no `read-mark` was ever posted; a load now takes the server's mark, or one still owed ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md)).
