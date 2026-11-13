### Changed - `/api/auth/verify` reads the platform config with one query, shared by concurrent requests

The maintenance check ran two queries per request; it now runs one, and concurrent requests share
it - never a timed cache, and a config write drops the shared read
([sessions](docs/wiki/sessions.md)).
