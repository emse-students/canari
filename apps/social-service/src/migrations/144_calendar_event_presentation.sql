-- Migration 144 (142 and 143 are held by #3156): a BDE may file a NEUTRAL agenda event, shown
-- as "Campus" with no association
-- (owner, 2026-11-08; docs/wiki/frontend/modules/calendar.md, "Neutral campus events").
--
-- presentation varchar(16) NOT NULL DEFAULT 'association': 'association' is every event as it was;
-- 'neutral' keeps the BDE as the accountable owner (rights, validation, audience, notices) and hides
-- it from every reader who does not manage its agenda. The default is the old behaviour, so the
-- previous release, which never names the column, keeps writing what it always wrote.
--
-- Two CHECKs: the value is one of the two, and a neutral event links no registration form (a form
-- page names its association, so a link would name the BDE the presentation hides).
--
-- ADDITIVE: a column with a constant default (catalogue only since PostgreSQL 11, no rewrite) and two
-- CHECKs added NOT VALID then validated (the scan runs under SHARE UPDATE EXCLUSIVE, writes go on;
-- every existing row is 'association', so both hold). A rollback leaves a column the old code ignores;
-- a neutral row it then serves names its BDE again, which is the state before this release.
-- Idempotent for CD: IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before each ADD CONSTRAINT.
-- LOCKS: ACCESS EXCLUSIVE on association_calendar_events for the catalogue change alone; a request
-- holding the lock makes the migration give up after 5 s rather than queue (the re-run is safe).

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE association_calendar_events
  ADD COLUMN IF NOT EXISTS presentation varchar(16) NOT NULL DEFAULT 'association';

ALTER TABLE association_calendar_events
  DROP CONSTRAINT IF EXISTS association_calendar_events_presentation_check;
ALTER TABLE association_calendar_events
  ADD CONSTRAINT association_calendar_events_presentation_check
  CHECK (presentation IN ('association', 'neutral')) NOT VALID;

ALTER TABLE association_calendar_events
  DROP CONSTRAINT IF EXISTS association_calendar_events_neutral_no_form_check;
ALTER TABLE association_calendar_events
  ADD CONSTRAINT association_calendar_events_neutral_no_form_check
  CHECK (presentation <> 'neutral' OR "linkedFormId" IS NULL) NOT VALID;

COMMIT;

ALTER TABLE association_calendar_events
  VALIDATE CONSTRAINT association_calendar_events_presentation_check;
ALTER TABLE association_calendar_events
  VALIDATE CONSTRAINT association_calendar_events_neutral_no_form_check;
