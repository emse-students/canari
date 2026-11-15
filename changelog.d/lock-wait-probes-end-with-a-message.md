### Fixed - an integration probe that never sees its lock wait now fails instead of hanging

Every lock-wait probe of the social-service and chat-delivery integration suites runs through one helper that throws what it observed (the operation settled before the wait was seen, or the server's activity after 2,000 reads); the few tests that need the count assert the result themselves. Fixed advisory-lock ids became per-run ([durable-rules](docs/wiki/durable-rules.md)).
