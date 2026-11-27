-- Migration 030: the Alumni merge, extended (D52-D58, docs/wiki/profiles-and-access.md).
--
-- `alumni_merges` gains five columns:
--   mode               `auto` (the target is the unique name-and-promo match, D47) or `manual` (the
--                      admin decided identity, D55); every row written before this file was `auto`;
--   reason             the admin's written reason, required for a manual merge (20-1000 characters,
--                      code points, checked by core-service); never sent to MiConnect; blanked when
--                      the target is erased while the merge is open;
--   duplicateSubject   the duplicate's and the target's MiConnect `uid` (the OIDC subject every
--   targetSubject      provider of the estate gives them, `hashed_user_id`), read at the mark while
--                      both exist: once the duplicate is deleted its subject is gone for good, and the
--                      sibling sites find its account by that subject alone (D54);
--   completedBy        `push` (MiConnect's webhook) or `reconciler` (the admin page's reading).
--
-- `alumni_merge_site_jobs`: one durable job per completed merge and sibling site (`sky`, `migallery`,
-- `le-cercle`), written in the transaction that closes the merge, run by core-service's worker until
-- the site answers what it did (D53, D54). EACH JOB CARRIES THE SUBJECTS IT NEEDS, so it never reads
-- its merge row: a `transfer` moves the duplicate's account onto the target's subject; an `erase`
-- (no target subject) erases the duplicate's account on that site. NOTHING CASCADES TO A JOB: the
-- target's erasure (CORE_ERASURE_STATEMENTS, the register's M1) deletes the jobs already done and
-- turns every job still owed into an `erase` before it deletes the merge row, whose deletion then only
-- nulls `mergeId` (ON DELETE SET NULL) - a duplicate's account on a sibling site is never left behind
-- because the person it was merged into left. `unreadySince`: the site answered 404 (its endpoint not
-- served yet), asked again daily, reported once a day per site.
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
ALTER TABLE alumni_merges ADD COLUMN IF NOT EXISTS "duplicateSubject" VARCHAR(128);
ALTER TABLE alumni_merges ADD COLUMN IF NOT EXISTS "targetSubject" VARCHAR(128);
ALTER TABLE alumni_merges ADD COLUMN IF NOT EXISTS "completedBy" VARCHAR(16);

CREATE TABLE IF NOT EXISTS alumni_merge_site_jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "mergeId"           UUID REFERENCES alumni_merges(id) ON DELETE SET NULL,
    site                VARCHAR(32) NOT NULL,
    kind                VARCHAR(8) NOT NULL DEFAULT 'transfer',
    "duplicateSubject"  VARCHAR(128) NOT NULL,
    "targetSubject"     VARCHAR(128),
    "createdAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
    attempts            INT NOT NULL DEFAULT 0,
    "nextAttemptAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "lastAttemptAt"     TIMESTAMPTZ,
    "lastError"         VARCHAR(500),
    "blockedAt"         TIMESTAMPTZ,
    "unreadySince"      TIMESTAMPTZ,
    outcome             VARCHAR(32),
    "completedAt"       TIMESTAMPTZ,
    CONSTRAINT "CHK_alumni_merge_site_jobs_kind" CHECK (
        (kind = 'transfer' AND "targetSubject" IS NOT NULL) OR (kind = 'erase' AND "targetSubject" IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_alumni_merge_site_jobs_merge_site"
    ON alumni_merge_site_jobs ("mergeId", site);
CREATE INDEX IF NOT EXISTS "IDX_alumni_merge_site_jobs_due"
    ON alumni_merge_site_jobs ("nextAttemptAt") WHERE "completedAt" IS NULL AND "blockedAt" IS NULL;
