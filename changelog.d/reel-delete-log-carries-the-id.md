### Fixed - the server's reel-delete log lines name the reel instead of "undefined"

The id was read from the entity after the repository's remove had cleared it; it is now read before ([mobile](docs/wiki/frontend/mobile.md)).
