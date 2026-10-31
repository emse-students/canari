### Changed - the identity provider's database runs PostgreSQL 18

MiConnect's PostgreSQL moved from 16 to 18 by a dump and restore onto a new volume, rehearsed on a copy first; the compose file carries the 18 image and its new mount, and the 16 volume is kept as the rollback ([authentik](docs/wiki/infrastructure/authentik.md#postgresql-16---18-2026-10-31)).
