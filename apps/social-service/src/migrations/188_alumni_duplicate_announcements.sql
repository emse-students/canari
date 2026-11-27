-- Migration 188: the ledger of the Alumni duplicates' found-notices already told (the 1.8.3 admin
-- queue, docs/wiki/decisions/owner-decisions-of-2026-11-27.md).
--
-- core-service tells the admins of a batch of duplicates by ONE call (`internal/notifications/
-- alumni-duplicates-found`) and records the batch as told only when the answer comes back. An answer
-- lost on the way would make the same call again, and the admins' phones ring twice for one batch:
-- this row is the witness. The caller names its batch by `batchId` (a digest of the batch's sorted
-- uuids); a batch whose id is here is NOT told again.
--
-- ONE new table, schema only, no backfill. It holds no personal data: a digest and a time.
--
-- ROLLBACK. An older image never reads it; dropping it only re-opens the (rare) double push.
--   DROP TABLE IF EXISTS alumni_duplicate_announcements;
--
-- LOCKS. CREATE TABLE of a new table with no foreign key takes no lock another table feels; the
-- migration gives up after 5 s all the same. IDEMPOTENT: IF NOT EXISTS.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS alumni_duplicate_announcements (
  "batchId" varchar(64) PRIMARY KEY,
  "announcedAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMIT;
