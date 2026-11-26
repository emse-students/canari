-- Migration 030: the Alumni merge, extended (D52-D58, docs/wiki/profiles-and-access.md).
--
-- `alumni_merges` gains five columns:
--   mode               `auto` (the target is the unique name-and-promo match, D47) or `manual` (the
--                      admin decided identity, D55); every row written before this file was `auto`;
--   reason             the admin's written reason, required for a manual merge (20-1000 characters,
--                      checked by core-service); never sent to MiConnect;
--   duplicateSubject   the duplicate's and the target's MiConnect `uid` (the OIDC subject every
--   targetSubject      provider of the estate gives them, `hashed_user_id`), read at the mark while
--                      both exist: once the duplicate is deleted its subject is gone for good, and the
--                      sibling sites find its account by that subject alone (D54);
--   completedBy        `push` (MiConnect's webhook) or `reconciler` (the admin page's reading).
--
-- `alumni_merge_site_jobs`: one durable job per completed merge and sibling site (`sky`, `migallery`,
-- `le-cercle`), written in the transaction that closes the merge, run by core-service's worker until
-- the site answers what it did (D53, D54). It is erased with its merge (ON DELETE CASCADE): a merge
-- row goes with its target's erasure (CORE_ERASURE_STATEMENTS), the register's M1.
--
-- ROLLOUT ORDER. The deploy applies migrations before it starts the new services, while the previous
-- release still runs: its code never names these columns (its INSERT leaves `mode` to its default,
-- `auto`, which is what that code does) nor this table. Additive only.
--
-- LOCKS: `alumni_merges` is read only by the admin page; adding a nullable column, or one with a
-- constant default, is a catalogue change. IDEMPOTENT: the deploy ledger replays a file whose
-- predecessor failed mid-run.

SET lock_timeout = '5s';

ALTER TABLE alumni_merges ADD COLUMN IF NOT EXISTS mode VARCHAR(8) NOT NULL DEFAULT 'auto';
ALTER TABLE alumni_merges ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE alumni_merges ADD COLUMN IF NOT EXISTS "duplicateSubject" VARCHAR(255);
ALTER TABLE alumni_merges ADD COLUMN IF NOT EXISTS "targetSubject" VARCHAR(255);
ALTER TABLE alumni_merges ADD COLUMN IF NOT EXISTS "completedBy" VARCHAR(16);

CREATE TABLE IF NOT EXISTS alumni_merge_site_jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "mergeId"           UUID NOT NULL REFERENCES alumni_merges(id) ON DELETE CASCADE,
    site                VARCHAR(32) NOT NULL,
    "duplicateSubject"  VARCHAR(255) NOT NULL,
    "targetSubject"     VARCHAR(255) NOT NULL,
    "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts            INT NOT NULL DEFAULT 0,
    "nextAttemptAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "lastAttemptAt"     TIMESTAMPTZ,
    "lastError"         VARCHAR(500),
    "blockedAt"         TIMESTAMPTZ,
    outcome             VARCHAR(32),
    "completedAt"       TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_alumni_merge_site_jobs_merge_site"
    ON alumni_merge_site_jobs ("mergeId", site);
CREATE INDEX IF NOT EXISTS "IDX_alumni_merge_site_jobs_due"
    ON alumni_merge_site_jobs ("nextAttemptAt") WHERE "completedAt" IS NULL AND "blockedAt" IS NULL;
