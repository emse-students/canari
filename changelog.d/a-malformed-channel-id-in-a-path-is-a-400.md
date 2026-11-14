### Fixed - a malformed channel, community, message or role id in a path is answered 400

The two channel controllers declare their path parameters, so the global guard refuses a non-uuid before any handler runs ([social-service](docs/wiki/services/social-service.md#path-parameters-are-declared-and-one-global-guard-reads-the-declaration-2026-11-14)).
