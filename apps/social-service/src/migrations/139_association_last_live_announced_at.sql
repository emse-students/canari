-- Migration 139 : one announced live per association per 6 hours (2026-11-07, WP-1b).
--
-- docs/wiki/engagement.md, "WP-1b". Since WP-1 an association's live is pushed to everyone who can
-- see it - its whole campus - and a broadcaster may start six lives an hour. The limit needs to know
-- when the association's last live was ANNOUNCED, and `lives` cannot say: a live row is deleted at
-- its end. So the instant lives on the association.
--
-- `lastLiveAnnouncedAt`: written by segment 0's claim (`LivesService.confirm`), in the transaction
-- that stamps `lives."announcedAt"`, only when the previous one is NULL or older than 6 hours.
-- NULL means "never announced", so no backfill is owed.
--
-- ADDITIVE: one nullable column, no default, no row read or changed. Idempotent for CD: IF NOT
-- EXISTS. LOCKS: ALTER TABLE takes ACCESS EXCLUSIVE on `associations` for the catalogue change alone
-- (a nullable column with no default rewrites nothing), released at COMMIT; the migration gives up
-- after 5 s rather than queue.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE associations ADD COLUMN IF NOT EXISTS "lastLiveAnnouncedAt" timestamptz;

COMMIT;
