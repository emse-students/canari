-- Migration 188: the ledger of the Alumni duplicates already told to the admins (the 1.8.3 admin
-- queue, docs/wiki/decisions/owner-decisions-of-2026-11-27.md).
--
-- core-service tells the admins of the duplicates it found by calls to
-- `internal/notifications/alumni-duplicates-found`, and records them as told only when the answer
-- comes back. An answer lost on the way, or two flushes running at once, would call again with a set
-- that overlaps what was already told. This table is the witness, ONE ROW PER DUPLICATE: social
-- CLAIMS a duplicate here BEFORE it notifies (one INSERT ... ON CONFLICT DO NOTHING RETURNING), and
-- notifies ONLY the duplicates it newly claimed - a duplicate already here is never told again, however
-- the sets grow or overlap. A notice that fails releases exactly the rows it claimed, so a retry tells.
--
-- A row lives while its duplicate's flag does: the announce sweeps the rows whose flag is gone (the
-- merge completed, an account erased), so the table never outgrows `alumni_duplicate_flags`.
--
-- ONE new table, schema only, no backfill, no foreign key (the flag table is core-service's). It
-- holds a MiConnect uuid and a time, no name.
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
  "announcedAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
