### Changed - the gateway admits a socket in one step, 32 per account and 1000 in all

A socket is counted and registered under one lock; past either limit it is closed with 1013 and never registered ([chat-gateway](docs/wiki/services/chat-gateway.md#admission-one-step-two-limits-2026-11-12)).
