### Changed - the gateway admits a socket in one step, 32 per account and 1000 in all

A socket's place is counted and registered under one lock, before the upgrade; past either limit the request is answered 503 and never upgraded ([chat-gateway](docs/wiki/services/chat-gateway.md#admission-one-step-two-limits-2026-11-12)).
