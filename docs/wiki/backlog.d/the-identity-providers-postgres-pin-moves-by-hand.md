## P3 - the identity provider's PostgreSQL pin moves by hand, in its own window

**What changed (2026-11-13).** Canari's three compose files and CI moved `postgres:18-alpine` from
`sha256:898c60cb...` (PostgreSQL 18.6, built 2026-10-21) to `sha256:10187334...` (18.7, pushed
2026-11-12). `infrastructure/authentik/compose.yml` was deliberately NOT moved: it kept
`sha256:898c60cb...`, and its comment no longer claims the host holds that image because Canari pins
it too.

**Why not in the same change.** A Canari release never deploys the identity provider: its compose
file is brought up by hand on the shared host ([authentik](../infrastructure/authentik.md)), so a
digest moved there would be a line saying something nothing ran. Moving it is a stop and a start of
the sign-in database - every sign-in, Canari's and the other sites', waits for it.

**What the move is, when it is taken.** Same major (18), so no dump and restore: the cluster on
`miconnect_database_18` is reused as it is. Pull the new digest first (so the gap is only the
restart), change the one `image:` line, `up -d postgresql`, then the checks the 16 -> 18 cut-over
named for a served instance: health, OIDC discovery and JWKS, one real sign-in
([authentik](../infrastructure/authentik.md#postgresql-16---18-2026-10-31)). Until then the image
scan keeps reading the old digest through this file, so the postgres-scoped allowlist entries that
the old build alone still needs retire only with this move.

**Owed.** The window, chosen by the owner (it touches the sign-in of every site), and the one-line
pull request that records the digest it ran.
