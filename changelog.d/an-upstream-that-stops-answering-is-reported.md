### Added - a public name that stops answering opens an issue, once

The gallery's five-hour outage and a tunnel connector's 25 minutes of 2026-11-05 reported nothing; the `upstream` job of `scheduled.yml` now probes the gallery, dev, the legacy name and production, suspects a first failure, opens one issue on the second consecutive one and closes it with the downtime ([upstream-reachability](docs/wiki/infrastructure/upstream-reachability.md)).
