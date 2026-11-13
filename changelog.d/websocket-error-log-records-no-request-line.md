### Changed - the error log of a WebSocket location records no request line

The access log's redaction does not reach nginx's error log, so `/api/ws` and `/api/call` set their
own error log to `crit` ([logging](docs/wiki/infrastructure/logging.md#the-error-log-of-a-websocket-location-2026-11-13)).
