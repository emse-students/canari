### Fixed - the daily log-retention report reads docker's exit status, not the shape of its output

A `docker logs` that failed silently passed as a clean log; the DSI request now asks which mechanism rotates CrowdSec's logs before prescribing a setting, and keeps 10 days of slack on nginx ([dsi-log-retention-request](docs/wiki/infrastructure/dsi-log-retention-request.md)).
