## P3 - retire the identity provider's PostgreSQL 16 volume, kept as the rollback of 2026-10-31 (a deletion: the owner's yes)

MiConnect's database runs PostgreSQL 18 on a new volume since 2026-10-31; the 16 volume was left
untouched as the rollback ([authentik](../infrastructure/authentik.md#postgresql-16---18-2026-10-31)).
A rollback discards everything written on 18 since the cut-over (sessions, events, accounts created
by a first sign-in), so it is worth keeping for days, not weeks. **Retiring it is a deletion and
waits for the owner's yes.** Remove it BY NAME, never by a prune, after the same three checks as
Canari's 2026-09-18 ([databases](../infrastructure/databases.md#crossing-a-major-version---the-rehearsed-procedure)):
no container references it (`docker ps -a --filter volume=`), its `PG_VERSION` reads 16, and the live
stack answers on 18. The working copies of the cut-over on the host go with it; where they are is in
the private operations notes.
