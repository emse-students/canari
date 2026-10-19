### Added - live segments served from Canari's nginx cache, and a 24-viewer cap for the host (off on production)

A sealed live segment is now fetched without a token and answered by nginx from the second viewer on; only the canonical lower-case path is served (nginx owns the whole prefix), one address is bounded in bytes as well as requests, and a viewer past the host's uplink cap gets a typed `LIVE_FULL` ([lives](docs/wiki/services/lives.md#serving-a-segment-from-the-nginx-cache-wp-l4)).
