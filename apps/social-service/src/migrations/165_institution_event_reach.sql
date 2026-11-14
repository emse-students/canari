-- Migration 165 : the reach an institution chooses for each of its calendar events (owner, 2026-11-13).
--
-- docs/wiki/backlog.d/institution-event-reach.md. The events half of the reach migration 162 gave
-- posts, in the SAME shape, so the SAME predicate fragments read both (`spaces/reader-spaces.ts`:
-- `institutionReachAdmitsUserSql`, `institutionReachHoldsSpaceSql`, inside `eventVisibleToUserSql`):
-- an institution's event names WHICH SPACES of the institution's own audience it targets and WHICH
-- PUBLIC in them - everyone, the students (an account with a cursus) or the staff (no cursus).
--
-- 1. `association_calendar_events."reachPublic"`: NULL (no reach chosen: every event filed before
--    this file, and every event that is not an institution's) or one of 'all', 'students', 'staff'.
-- 2. `association_calendar_events."reachSpaces"`: NULL, or a jsonb array of `{"formation", "campus"}`
--    pairs - the spaces ticked. Read by containment (`@>`), so a malformed value contains nothing and
--    the event reaches nobody through its organiser's rules (it fails closed).
-- 3. Three CHECKs: the public is one of the three; the two columns are set together or not at all;
--    the spaces are a non-empty array. (Every event has an owner, so 162's "an entity's item only"
--    half has nothing to say here; the TYPE - an institution - is the write's to refuse, typed, since
--    a CHECK cannot read `associations`.)
--    Added NOT VALID then validated: the validation scans the table under SHARE UPDATE EXCLUSIVE,
--    which blocks neither reads nor writes, and every row is NULL on both columns so none can fail.
--
-- No backfill: an institution event filed before this file keeps NULL, which the predicate reads as
-- "the institution's whole audience, everyone" - what it was filed to.
--
-- ADDITIVE: two nullable columns with no default (catalogue changes, no rewrite) and three checks.
-- Reversible by hand: drop the three constraints, then the two columns (nothing else reads them).
-- Idempotent for CD: IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before each ADD CONSTRAINT.
-- LOCKS: ACCESS EXCLUSIVE on `association_calendar_events` for the catalogue changes alone (no scan,
-- no rewrite), released at COMMIT. A request holding it makes the migration give up after 5 s rather
-- than queue (the re-run is safe).

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE association_calendar_events ADD COLUMN IF NOT EXISTS "reachPublic" varchar(16) NULL;
ALTER TABLE association_calendar_events ADD COLUMN IF NOT EXISTS "reachSpaces" jsonb NULL;

ALTER TABLE association_calendar_events DROP CONSTRAINT IF EXISTS "CHK_calendar_events_reach_public";
ALTER TABLE association_calendar_events ADD CONSTRAINT "CHK_calendar_events_reach_public"
  CHECK ("reachPublic" IS NULL OR "reachPublic" IN ('all', 'students', 'staff')) NOT VALID;

ALTER TABLE association_calendar_events DROP CONSTRAINT IF EXISTS "CHK_calendar_events_reach_together";
ALTER TABLE association_calendar_events ADD CONSTRAINT "CHK_calendar_events_reach_together"
  CHECK (("reachPublic" IS NULL) = ("reachSpaces" IS NULL)) NOT VALID;

ALTER TABLE association_calendar_events DROP CONSTRAINT IF EXISTS "CHK_calendar_events_reach_spaces_shape";
ALTER TABLE association_calendar_events ADD CONSTRAINT "CHK_calendar_events_reach_spaces_shape"
  CHECK ("reachSpaces" IS NULL
    OR CASE WHEN jsonb_typeof("reachSpaces") = 'array'
         THEN jsonb_array_length("reachSpaces") > 0 ELSE false END) NOT VALID;

COMMIT;

ALTER TABLE association_calendar_events VALIDATE CONSTRAINT "CHK_calendar_events_reach_public";
ALTER TABLE association_calendar_events VALIDATE CONSTRAINT "CHK_calendar_events_reach_together";
ALTER TABLE association_calendar_events VALIDATE CONSTRAINT "CHK_calendar_events_reach_spaces_shape";
