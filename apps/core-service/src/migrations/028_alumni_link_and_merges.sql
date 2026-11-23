-- Migration 028: the Alumni link a sign-in reports, and the trace of every Alumni merge.
--
-- WP8 re-decided (docs/wiki/profiles-and-access.md, D44, D47, D48).
--
-- `users."alumniLinked"`: the `alumni_linked` claim of the account's last sign-in. NULL is UNKNOWN
-- (a MiConnect that does not emit the claim yet), never "not linked" - the reminder banner shows only
-- on an explicit false. Additive and nullable: every older image ignores it.
--
-- `alumni_merges`: one row per "Rattacher" an admin made (D48: the duplicate an Alumni sign-in
-- created is DELETED, its Canari account erased). Traced like a profile edit (D9): who
-- (`actorId`), what (the duplicate's MiConnect uuid and username, the account it belonged with, and
-- what the duplicate held in Canari when the admin confirmed), when. The row is written BEFORE the
-- deletion at MiConnect and completed after the erasure is recorded, so a merge interrupted between
-- the two resumes from it (`AlumniMergeService.merge`) instead of being lost: ONE PENDING ROW PER
-- DUPLICATE, enforced by the partial unique index.
--
-- No foreign keys: `users.id` is the OIDC subject (a varchar), and the target's own erasure deletes
-- its rows (`CORE_ERASURE_STATEMENTS`), the acting admin's erasure blanks `actorId`.
--
-- LOCKS. ADD COLUMN of a nullable column with no default is a catalogue change (no rewrite), under
-- ACCESS EXCLUSIVE on `users` until COMMIT; `users` is read on every request, so the migration gives
-- up after 5 s rather than queue every login behind a long transaction. The re-run is safe.
--
-- IDEMPOTENT: the deploy ledger replays a file whose predecessor failed mid-run.

SET lock_timeout = '5s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS "alumniLinked" BOOLEAN;

CREATE TABLE IF NOT EXISTS alumni_merges (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "actorId"            VARCHAR(255) NOT NULL,
    "duplicateUuid"      VARCHAR(36) NOT NULL,
    "duplicateUsername"  VARCHAR(150) NOT NULL,
    "targetUuid"         VARCHAR(36) NOT NULL,
    "targetUserId"       VARCHAR(255),
    held                 JSONB NOT NULL,
    "requestedAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
    "completedAt"        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_alumni_merges_pending"
    ON alumni_merges ("duplicateUuid") WHERE "completedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "IDX_alumni_merges_target" ON alumni_merges ("targetUserId");
