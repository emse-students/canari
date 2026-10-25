### Changed - backlog: the outbox sends into a group whose commit outcome it already knows is unknown

DUP-5 on `1.4.1-alpha.4` showed three send attempts failing on `CommitOutcomeUnknownError` while the client already held that state; filed as a P3 ([backlog](docs/wiki/backlog.md)).
