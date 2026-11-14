### Changed - core-service and media-service declare their path parameters

The guard of social-service is provided in both: a session, announcement or correction-request id that is not a uuid is answered `400` before its handler runs ([core-service](docs/wiki/services/core-service.md#path-parameters-are-declared-2026-11-14)).
