### Added - a public name whose tunnel has no connector is reported within 15 minutes

The gallery's five-hour outage and the dev connector's 25 minutes of 2026-11-05 reported nothing; the `upstream` job of `scheduled.yml` now asks the gallery, dev, the legacy name and production every 15 minutes, classes each failure and goes red ([upstream-reachability](docs/wiki/infrastructure/upstream-reachability.md)).
