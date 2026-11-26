### Fixed - going live again after a reload or a crash no longer waits for the server's 60 s sweep

A start now ends the same account's own open live in the same transaction, from the database, instead
of answering `409 LIVE_ALREADY_OPEN` until the absence sweep did ([lives](docs/wiki/services/lives.md)).
