### Fixed - social-service no longer exits at boot when a migration has not been applied yet

The media backfills ran before the deploy applied the migration they read, which failed the dev deploy of `v1.0.1-alpha.2` ([social-service](docs/wiki/services/social-service.md#a-query-at-boot-runs-before-the-migration-that-adds-its-column-2026-10-02)).
