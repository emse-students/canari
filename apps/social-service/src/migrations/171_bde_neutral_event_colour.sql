-- Migration 171: each BDE chooses the colour of its neutral ("Campus") agenda events
-- (owner, 2026-11-14; docs/wiki/frontend/modules/calendar.md, "Neutral campus events").
--
-- associations."neutralEventColor" varchar(7) NULL: a #rrggbb hex, like associations.color. NULL is
-- every association as it was, and for a BDE it means "the derived Campus accent", so nothing
-- changes until a BDE chooses. The server writes it only on a BDE (a service check, not a constraint:
-- a BDE is a derived fact, `isBdeAssociationSql`, not a column).
--
-- ADDITIVE: a nullable column with no default (catalogue only, no rewrite); a CHECK added NOT VALID
-- then validated (every existing row is NULL, so it holds). A rollback leaves a column the old code
-- ignores. Idempotent for CD: IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before ADD CONSTRAINT.
-- LOCKS: ACCESS EXCLUSIVE on associations for the catalogue change alone; a request holding the
-- lock makes the migration give up after 5 s rather than queue (the re-run is safe).

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE associations
  ADD COLUMN IF NOT EXISTS "neutralEventColor" varchar(7);

ALTER TABLE associations
  DROP CONSTRAINT IF EXISTS associations_neutral_event_colour_check;
ALTER TABLE associations
  ADD CONSTRAINT associations_neutral_event_colour_check
  CHECK ("neutralEventColor" IS NULL OR "neutralEventColor" ~ '^#[0-9A-Fa-f]{6}$') NOT VALID;

COMMIT;

ALTER TABLE associations VALIDATE CONSTRAINT associations_neutral_event_colour_check;
