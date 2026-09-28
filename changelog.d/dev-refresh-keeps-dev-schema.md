### Fixed - refreshing dev from production no longer rolls dev's schema back to production's

The copy now ends by applying the migrations of the commit dev runs, with the deploy's own loop
([dev-environment](docs/wiki/infrastructure/dev-environment.md#the-copy-ends-on-devs-schema-not-productions---it-runs-the-deploys-own-migration-loop-2026-09-28)).
