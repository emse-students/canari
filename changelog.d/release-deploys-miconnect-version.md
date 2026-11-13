### Added - the release deploys MiConnect's authentik version, and a daily job reports drift

A pre-release puts the test MiConnect, a stable production, on the image `compose.yml` pins (dump,
restart only on a difference, health and OIDC checks, automatic rollback); Dependabot watches that
pin; `scheduled.yml` reports running images against the released pins and hand edits the next stable
would overwrite ([authentik](docs/wiki/infrastructure/authentik.md#the-release-deploys-miconnects-version-2026-11-13)).
