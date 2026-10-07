### Fixed - a purged or absent media is already two typed answers; the open entry is closed

Measured on prod: 0 404 and 1 410 in 612 `/api/media/:id` requests, so no change to the answers; the server case is now pinned by a test ([media-service](docs/wiki/services/media-service.md#a-purged-object-reads-as-410-an-absent-one-as-404---and-both-were-already-typed-measured-2026-10-08)).
