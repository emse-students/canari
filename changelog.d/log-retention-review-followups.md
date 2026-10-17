### Fixed - the daily log-retention report reads docker's exit status, not the shape of its output

A `docker logs` that failed silently passed as a clean log; the host-level retention request keeps slack and names the mechanism that rotates each log before prescribing a setting ([logging](docs/wiki/infrastructure/logging.md)).
