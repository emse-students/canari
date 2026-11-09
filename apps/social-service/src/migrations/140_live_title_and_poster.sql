-- Migration 140 (139 is held by #3119's 139_association_last_live_announced_at.sql): a live's TITLE and its PREVIEW IMAGE (owner, 2026-11-07).
--
-- docs/wiki/services/lives.md, "Titles and the preview". Two additions to `lives`, nothing else:
--
-- 1. "title" varchar(80) NULL: optional, entered on the launch screen and editable while on air
--    (`PATCH /api/lives/:id`). PLAIN TEXT the server stores and serves, like a post's text; NULL is
--    "no title" (an empty or blank title is written NULL by the service, never ''). The CHECK holds
--    the service's own bound a second time: 1 to 80 characters (`char_length` counts code points,
--    as `LIVE_TITLE_MAX_CHARS` does).
-- 2. The POSTER - a small still image the broadcaster sends every few segments, SEALED under the live
--    key, stored in the media store under the live's own prefix `live/<id>/<name>` beside its
--    segments, so the live's purge deletes it with them and nginx serves it from the same cached
--    location (`/api/media/public/live/<id>/<name>`):
--      "posterName"        the stored poster's random name (a uuid, learned from `GET /api/lives`);
--      "posterAt"          when it was stored, on the DATABASE's clock - the card's age, and the
--                          server's rate bound (`LIVE_POSTER_MIN_INTERVAL_MS`);
--      "posterPendingName" / "posterPendingAt"
--                          THE RESERVATION of a poster being stored, written in a committed step
--                          BEFORE the store, exactly as the segment's `pendingName` / `pendingAt`
--                          (migration 091): the purge leaves a live alone while either is live, so
--                          no poster lands in the store after its live's purge.
--    Each pair is whole or absent (two CHECKs).
--
-- ADDITIVE: five nullable columns with no default (a catalogue change, no rewrite) and three CHECKs
-- that every existing row satisfies (all NULL). The previous release never reads or writes them, so
-- the overlap deploy and a rollback are safe: an old replica's INSERT leaves them NULL.
-- Idempotent for CD: IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before each ADD CONSTRAINT.
-- LOCKS: ACCESS EXCLUSIVE on `lives` for the catalogue changes (no scan: the CHECKs are added NOT
-- VALID and validated after the COMMIT under SHARE UPDATE EXCLUSIVE). `lives` holds the open lives
-- and the ended ones not yet purged - a handful of rows. A request holding the lock makes the
-- migration give up after 5 s rather than queue (the re-run is safe).

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE lives ADD COLUMN IF NOT EXISTS "title" varchar(80);
ALTER TABLE lives ADD COLUMN IF NOT EXISTS "posterName" uuid;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS "posterAt" timestamptz;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS "posterPendingName" uuid;
ALTER TABLE lives ADD COLUMN IF NOT EXISTS "posterPendingAt" timestamptz;

ALTER TABLE lives DROP CONSTRAINT IF EXISTS lives_title_length;
ALTER TABLE lives ADD CONSTRAINT lives_title_length
  CHECK ("title" IS NULL OR char_length("title") BETWEEN 1 AND 80) NOT VALID;

ALTER TABLE lives DROP CONSTRAINT IF EXISTS lives_poster_whole;
ALTER TABLE lives ADD CONSTRAINT lives_poster_whole
  CHECK (("posterName" IS NULL) = ("posterAt" IS NULL)) NOT VALID;

ALTER TABLE lives DROP CONSTRAINT IF EXISTS lives_poster_pending_whole;
ALTER TABLE lives ADD CONSTRAINT lives_poster_pending_whole
  CHECK (("posterPendingName" IS NULL) = ("posterPendingAt" IS NULL)) NOT VALID;

COMMIT;

ALTER TABLE lives VALIDATE CONSTRAINT lives_title_length;
ALTER TABLE lives VALIDATE CONSTRAINT lives_poster_whole;
ALTER TABLE lives VALIDATE CONSTRAINT lives_poster_pending_whole;
