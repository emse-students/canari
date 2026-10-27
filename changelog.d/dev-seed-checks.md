### Fixed - the dev seed meets every CHECK on its tables, asserted on the pull request

The seeded follows carry their `acceptedAt`, which migration 114 requires, and `seed.test.ts` now holds every seeded row to every CHECK the entities and migrations declare ([dev-environment](docs/wiki/infrastructure/dev-environment.md)).
