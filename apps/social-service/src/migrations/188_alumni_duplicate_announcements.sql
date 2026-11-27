-- Migration 188: the ledger of the Alumni duplicates already told to the admins (the 1.8.3 admin
-- queue, docs/wiki/decisions/owner-decisions-of-2026-11-27.md).
--
-- core-service tells the admins of the duplicates it found by calls to
-- `internal/notifications/alumni-duplicates-found`, and records them as told only when the answer
-- comes back. An answer lost on the way, or two flushes running at once, would call again with a set
-- that overlaps what was already told. This table is the witness, ONE ROW PER DUPLICATE: social
-- CLAIMS a duplicate here BEFORE it notifies, in the SAME transaction as the admins' bell rows (so a
-- failure rolls the claim back with them and a crash leaves nothing claimed), and writes rows only for
-- the duplicates it newly claimed - a duplicate already here is never told again, however the sets
-- grow or overlap.
--
-- `"flaggedAt"` is the INCARNATION of the duplicate's flag (`alumni_duplicate_flags."flaggedAt"`, core
-- migration 031), copied at the claim. A claim conflicts only with the SAME incarnation: a duplicate
-- whose flag was deleted (a completed merge, an erased account) and is flagged again has a new
-- `flaggedAt` and is told anew, whether or not a sweep has run in between.
--
-- A row lives while its duplicate's flag does: the announce sweeps the rows whose flag is gone, so the
-- table never outgrows `alumni_duplicate_flags`.
--
-- ONE new table, schema only, no backfill, no foreign key (the flag table is core-service's). It
-- holds a MiConnect uuid and two times, no name.
--
-- ROLLBACK. An older image never reads it; dropping it only re-opens the (rare) double push.
--   DROP TABLE IF EXISTS alumni_duplicate_announcements;
--
-- LOCKS. CREATE TABLE of a new table with no foreign key takes no lock another table feels; the
-- migration gives up after 5 s all the same. IDEMPOTENT: IF NOT EXISTS.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS alumni_duplicate_announcements (
  "duplicateUuid" uuid PRIMARY KEY,
  "flaggedAt" timestamptz NOT NULL,
  "announcedAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
