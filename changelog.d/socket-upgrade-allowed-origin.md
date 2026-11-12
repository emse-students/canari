### Changed - a socket upgrade must come from an allowed origin

The chat gateway answers `403` to a WebSocket upgrade whose `Origin` is not in `ALLOW_ORIGIN`; a
request with no `Origin` (a native client) is accepted, and `*` is never taken for a list
([chat-gateway](docs/wiki/services/chat-gateway.md#a-socket-upgrade-must-come-from-an-allowed-origin-2026-11-12)).
