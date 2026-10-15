### Fixed - the key-distribution groups are asked about once per connection, not twice

The connection sync and the discovery that follows it each asked the server about the same key groups (16 serial requests and 16 `WASM kept` lines per connection on a Pixel 6a); the discovery now reuses the sync's answer for that pass only ([startup audit](docs/wiki/frontend/startup-load-audit-2026-10-12.md)).
