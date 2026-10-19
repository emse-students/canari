### Added - live segments served from Canari's nginx cache, and a 24-viewer cap for the host (off on production)

A sealed live segment is now fetched without a token and answered by nginx from the second viewer on; a viewer past the host's uplink cap gets a typed `LIVE_FULL` ([lives](docs/wiki/services/lives.md#serving-a-segment-from-the-nginx-cache-wp-l4)).
