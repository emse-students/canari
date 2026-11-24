-- Migration 029: an Alumni merge MARKS, and MiConnect merges at the duplicate's next sign-in.
--
-- D48 redesigned (docs/wiki/profiles-and-access.md): "Rattacher" no longer deletes the duplicate at
-- MiConnect. It writes a mark on it, and MiConnect moves the Alumni link onto the marked account and
-- deletes the duplicate when that Alumni identity next signs in (30-sources.yaml). A row of
-- `alumni_merges` now has four states, read from its timestamps:
--   REQUESTED  "requestedAt" only - the trace written, the mark not yet;
--   MARKED     "markedAt"         - the mark written, waiting for the sign-in;
--   COMPLETED  "completedAt"      - the duplicate is gone from MiConnect (the list reconciles it, and
--                                   the duplicate's Canari account is erased then);
--   CANCELLED  "cancelledAt"      - an admin removed the mark ("cancelledBy"); "completedAt" is set
--                                   too, so a cancelled row is CLOSED.
-- OPEN therefore stays "completedAt" IS NULL, the predicate of 028's partial unique index: ONE OPEN
-- ROW PER DUPLICATE is enforced by that index, unchanged.
--
-- ROLLOUT ORDER. The deploy applies migrations before it starts the new services
-- (deploy-environment.sh), while the previous release still runs. That release's code (028) never
-- names these columns, and its INSERT's ON CONFLICT names the index this file leaves alone, so it
-- runs unchanged beside them. The new code never runs before this file.
--
-- LOCKS: `alumni_merges` is read only by the admin page; adding nullable columns is a catalogue
-- change. IDEMPOTENT: the deploy ledger replays a file whose predecessor failed mid-run.

SET lock_timeout = '5s';

ALTER TABLE alumni_merges ADD COLUMN IF NOT EXISTS "markedAt" TIMESTAMPTZ;
ALTER TABLE alumni_merges ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMPTZ;
ALTER TABLE alumni_merges ADD COLUMN IF NOT EXISTS "cancelledBy" VARCHAR(255);

-- The erasure finds a person's merges by their MiConnect uuid too (a target with no Canari account
-- when it was merged has no "targetUserId").
CREATE INDEX IF NOT EXISTS "IDX_alumni_merges_target_uuid" ON alumni_merges ("targetUuid");
