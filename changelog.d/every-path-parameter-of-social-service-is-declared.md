### Changed - every controller of social-service declares its path parameters

The declaration read by the global guard is the one mechanism: the per-parameter uuid pipes are gone, and a malformed id is a `400` on every route that names a uuid row ([social-service](docs/wiki/services/social-service.md#path-parameters-are-declared-and-one-global-guard-reads-the-declaration-2026-11-14)).
