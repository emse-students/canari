### Fixed - an integration probe that never sees its lock wait now fails with a message

Every lock-wait probe of the social-service and chat-delivery integration suites runs through one helper that fails with what it observed (the operation settled before the wait was seen, or the server's activity after a bound of 2,000 reads) instead of looping until jest times out; fixed advisory-lock ids became per-run ([durable-rules](docs/wiki/durable-rules.md)).
