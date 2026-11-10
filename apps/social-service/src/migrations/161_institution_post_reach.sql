-- Migration 161 : the reach an institution chooses for each of its posts (owner, 2026-11-10).
--
-- docs/wiki/backlog.d/institution-post-reach.md. An institution's post names WHICH SPACES of the
-- institution's own audience it targets and WHICH PUBLIC in them - everyone, the students (an
-- account with a cursus, so a space) or the staff (no cursus). The rule is read in the one visibility
-- predicate (`spaces/reader-spaces.ts`, `postVisibleToUserSql`), so a change is read at once by every
-- path, both ways.
--
-- 1. `posts."reachPublic"`: NULL (no reach chosen: every post written before this file, and every
--    post that is not an institution's) or one of 'all', 'students', 'staff'.
-- 2. `posts."reachSpaces"`: NULL, or a jsonb array of `{"formation", "campus"}` pairs - the spaces
--    ticked. Read by containment (`@>`), the shape `users.cursus` is read with, so a malformed value
--    contains nothing and the post reaches nobody through it (it fails closed).
-- 3. Three CHECKs: the two columns are set together or not at all; a reach is an entity's post only
--    (a personal post never carries one; the TYPE is the write's to refuse, typed, since a CHECK
--    cannot read `associations`); the spaces are a non-empty array.
--    Added NOT VALID then validated: the validation scans `posts` under SHARE UPDATE EXCLUSIVE, which
--    blocks neither reads nor writes, and every row is NULL on both columns so none can fail.
--
-- No backfill: an institution post published before this file keeps NULL, which the predicate reads
-- as "the institution's whole audience, everyone" - what it was published to.
--
-- ADDITIVE: two nullable columns with no default (catalogue changes, no rewrite) and three checks.
-- Idempotent for CD: IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before each ADD CONSTRAINT.
-- LOCKS: ACCESS EXCLUSIVE on `posts` for the catalogue changes alone (no scan, no rewrite), released
-- at COMMIT. A request holding it makes the migration give up after 5 s rather than queue (the re-run
-- is safe).

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS "reachPublic" varchar(16) NULL;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS "reachSpaces" jsonb NULL;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS "CHK_posts_reach_public";
ALTER TABLE posts ADD CONSTRAINT "CHK_posts_reach_public"
  CHECK ("reachPublic" IS NULL OR "reachPublic" IN ('all', 'students', 'staff')) NOT VALID;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS "CHK_posts_reach_together";
ALTER TABLE posts ADD CONSTRAINT "CHK_posts_reach_together"
  CHECK (("reachPublic" IS NULL) = ("reachSpaces" IS NULL)
    AND ("reachPublic" IS NULL OR "associationId" IS NOT NULL)) NOT VALID;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS "CHK_posts_reach_spaces_shape";
ALTER TABLE posts ADD CONSTRAINT "CHK_posts_reach_spaces_shape"
  CHECK ("reachSpaces" IS NULL
    OR CASE WHEN jsonb_typeof("reachSpaces") = 'array'
         THEN jsonb_array_length("reachSpaces") > 0 ELSE false END) NOT VALID;

COMMIT;

ALTER TABLE posts VALIDATE CONSTRAINT "CHK_posts_reach_public";
ALTER TABLE posts VALIDATE CONSTRAINT "CHK_posts_reach_together";
ALTER TABLE posts VALIDATE CONSTRAINT "CHK_posts_reach_spaces_shape";
