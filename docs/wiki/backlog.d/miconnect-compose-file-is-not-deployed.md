## P3 - the release deploys MiConnect's version, not its compose file; the test stack is on PostgreSQL 16

Since 2026-11-13 the release puts each MiConnect stack on the authentik image `compose.yml` pins
(`deploy-stack.sh`), through the `AUTHENTIK_TAG` line of the stack's `.env`. The rest of the file is
still copied by hand, and both host copies differ from it (measured 2026-11-13): production's lacks
the `MICONNECT_READER_TOKEN` line and the logging block; the test stack's has its own project name and
domain, and runs **PostgreSQL 16 on the volume `database`** where this file pins 18 on `database_18` -
the daily `drift` job reports it red until it moves.

**Done when** the test stack is on 18 (the 2026-10-31 procedure, [authentik](../infrastructure/authentik.md#postgresql-16---18-2026-10-31)),
the domain and project name are parameters of ONE compose file, and the release copies that file,
refusing a named volume that does not exist yet (a new volume is a data migration, never a deploy).
Then the `.env` line and its interpolation can go. Mechanism: [authentik](../infrastructure/authentik.md#the-release-deploys-miconnects-version-2026-11-13).
