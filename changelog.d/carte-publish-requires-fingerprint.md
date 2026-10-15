### Removed - a carte publish body without its fingerprint

Every client admitted at `minClientVersion` 1.2.7 posts `{ carte, fingerprint }` (since `v0.18.28`),
so a bare document, a missing fingerprint or a malformed one is now a 400
([carte-vie-asso](docs/wiki/carte-vie-asso.md)).
