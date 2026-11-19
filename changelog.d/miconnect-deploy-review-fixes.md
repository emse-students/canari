### Fixed - the MiConnect deploy: authentik upgraded first, a rollback that sees system migrations, copies kept 30 days at most

A release now upgrades MiConnect before any other container, restores the dump when only authentik's
own system migrations ran, accepts a `.env` put back by its backup, keeps compose's host paths out of
the public log, and expires its rollback copies to 3 and 30 days at most, daily
([authentik](docs/wiki/infrastructure/authentik.md#the-release-deploys-miconnects-version-2026-11-13)).
