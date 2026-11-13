### Changed - the CORS allowlist is exact; no loopback origin in production

The four Nest services accept an origin only when a list names it, and production's rendered list
no longer carries the dev-server pair, which the dev and local estates keep
([chat-gateway](docs/wiki/services/chat-gateway.md#every-entry-and-why-it-is-there)).
