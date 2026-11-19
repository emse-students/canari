### Fixed - the MiConnect deploy: authentik upgraded first, a rollback that sees system migrations, copies kept 30 days at most

A release now upgrades MiConnect before any other container and keeps a NEWER running version (so
an older release's rerun still rolls the estate back), restores the dump when only authentik's own
system migrations ran, accepts a `.env` put back by its backup, counts only this run's restarts,
keeps host paths out of the public log, and expires its rollback copies to 3 and 30 days at most,
daily. It refuses early, read-only and with the exact hand command, what would stop it, checks that
the test stack rehearses production's upgrade, pulls anonymously under the host's 85 % disk ceiling,
asks each probe five times before a rollback, and redacts the blueprints' output ([authentik](docs/wiki/infrastructure/authentik.md#the-release-deploys-miconnects-version-2026-11-13)).
