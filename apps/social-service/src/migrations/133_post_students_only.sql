-- Migration 133 : the "Entre étudiants" switch on an association or list post (owner, 2026-11-04).
--
-- docs/wiki/profiles-and-access.md, "The Entre étudiants switch". A post marked `studentsOnly` is
-- read only by students (an account with a cursus, so a space) and by the members of the association
-- that published it, whatever the path: the gate is one conjunct of `postVisibleToUserSql`
-- (`spaces/reader-spaces.ts`, `studentsOnlyAdmitsUserSql`). OFF by default, for every existing post
-- and every new one: nothing anybody reads today changes with this file.
--
-- 1. `posts."studentsOnly"`: boolean NOT NULL DEFAULT false. A constant default is a catalogue change
--    since PostgreSQL 11 - no rewrite of `posts`.
-- 2. A CHECK that a personal post never carries it (decision 7: associations and lists only; the type
--    of the association is the write's to refuse, typed, since a CHECK cannot read another table).
--    Added NOT VALID then validated: the validation scans `posts` under SHARE UPDATE EXCLUSIVE, which
--    blocks neither reads nor writes, and every row is `false` so it cannot fail.
--
-- ADDITIVE: a new column with a constant default, a new check. Idempotent for CD: IF NOT EXISTS,
-- DROP CONSTRAINT IF EXISTS before the ADD CONSTRAINT.
-- LOCKS: ACCESS EXCLUSIVE on `posts` for the catalogue changes alone (no scan, no rewrite), released
-- at COMMIT. A request holding it makes the migration give up after 5 s rather than queue (the
-- re-run is safe).

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS "studentsOnly" boolean NOT NULL DEFAULT false;

ALTER TABLE posts DROP CONSTRAINT IF EXISTS "CHK_posts_students_only_entity";
ALTER TABLE posts ADD CONSTRAINT "CHK_posts_students_only_entity"
  CHECK (NOT "studentsOnly" OR "associationId" IS NOT NULL) NOT VALID;

COMMIT;

ALTER TABLE posts VALIDATE CONSTRAINT "CHK_posts_students_only_entity";
