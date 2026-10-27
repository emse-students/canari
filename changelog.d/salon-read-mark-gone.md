### Fixed - a read mark for a deleted salon is dropped instead of retried at every load

A `404` with the typed code `CHANNEL_NOT_FOUND` is the server's answer that the salon is gone: the owed mark is removed durably and logged once, other statuses and transport failures keep it ([offline-and-weak-network](docs/wiki/frontend/offline-and-weak-network.md)).
