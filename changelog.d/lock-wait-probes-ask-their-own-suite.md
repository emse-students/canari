### Fixed

- Eight integration suites waited for "a session of the database" to block on a lock and could be answered by another suite running beside them; each now asks its own sessions, which ends an intermittent failure of a bookings test under a parallel run ([durable-rules](docs/wiki/durable-rules.md)).
