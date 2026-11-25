## P3 - the release deploys MiConnect's version, not its compose file; the test stack is on PostgreSQL 16

target: 1.10.0

_2026-11-22: moved to 1.8.0 when 1.7.3 shipped._

_2026-11-20: moved to 1.7.3 when 1.7.2 shipped._

Since 2026-11-13 the release puts each MiConnect stack on the authentik image `compose.yml` pins
(`deploy-stack.sh`), through the `AUTHENTIK_TAG` line of the stack's `.env`. The rest of the file is
still copied by hand, and both host copies differ from it (measured 2026-11-13): production's lacks
the `MICONNECT_READER_TOKEN` line and the logging block; the test stack's has its own project name and
domain, and runs **PostgreSQL 16 on the volume `database`** where this file pins 18 on `database_18` -
the daily `drift` job reports it as one dated `KNOWN` warning, green, until 2026-12-31
(`infrastructure/deploy/image-drift-known.txt`), and red after that date if it has not moved.

**Done when** the test stack is on 18 (the 2026-10-31 procedure, [authentik](../infrastructure/authentik.md#postgresql-16---18-2026-10-31)),
the domain and project name are parameters of ONE compose file, and the release copies that file,
refusing a named volume that does not exist yet (a new volume is a data migration, never a deploy).
Then the `.env` line and its interpolation can go. Mechanism: [authentik](../infrastructure/authentik.md#the-release-deploys-miconnects-version-2026-11-13).

**Re-read 2026-11-25: still open, and wider.** The gate of #4103 (the in-app-browser interstitial in front of MiConnect) added a `gate` service and the `./leave-in-app-browser` directory to this `compose.yml`, and both reach the host by the lead's hand step ([leaving-in-app-browsers](../frontend/leaving-in-app-browsers.md#miconnect-in-production---the-hand-step)), as the rest of the file does. Building the release's copy is not a code change on its own: `deploy-stack.sh` refuses, by design, any `up` that would apply more than the tag (its `--dry-run` must read `Running` with the tag the stack runs), so a release that owns the whole file needs that invariant REPLACED by a reviewed one (which differences a release may apply, how a recreated `gate` keeps `AUTHENTIK_PUBLISH`, the rollback of a file). The order stays: the test stack on PostgreSQL 18 first (a hand step on the host, the 2026-10-31 procedure), then the parameters, then the copy.
