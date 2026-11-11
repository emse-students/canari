### Added - the sign-in handoff's verifier and landing logic, the source every site vendors

`libs/handoff/` holds the token verifier and the landing page's logic, tested against every vector (an unreachable key set is its own `keys_unavailable` class, never `invalid`), and `shape.mjs` checks that MiGallery's copies stay byte-identical ([design](docs/wiki/backlog.d/sign-in-handoff-to-the-ecosystem-sites-and-migallery-notifications.md)).
