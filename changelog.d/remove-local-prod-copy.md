### Removed - the local copy of production data

Production data is never copied to a workstation (owner decision, 2026-10-24): the fetch and restore scripts under `infrastructure/local/` and `make dump-prod` are gone, and local work uses the fictional seed ([dev-environment](docs/wiki/infrastructure/dev-environment.md)).
