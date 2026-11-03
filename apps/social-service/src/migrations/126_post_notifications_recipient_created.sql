-- Migration 126: the access path the bell reads, so its visibility re-check stops with the page.
--
-- `PostNotificationsService.getNotifications` serves a reader's newest rows, and since the review of
-- #2965 it re-checks, row by row, that the reader still sees the post a post-bound row is about
-- (`bellRowShownSql`, a correlated subquery). The table carried one index, on `recipientId`, so
-- every row of the reader was read and sorted, and the check ran on every one of them before the
-- LIMIT. With ("recipientId", "createdAt" DESC) the plan walks the reader's rows newest first and
-- stops once the page is full: the check runs on about one page of rows.
--
-- Measured on production, read-only, 2026-11-03: 24,136 rows over the 90-day retention, 517
-- recipients, per recipient p50 52, p90 55, p99 99, max 149 rows; association_post 22,927 of them.
-- docs/wiki/frontend/modules/posts.md, "The bell re-checks the post".
--
-- Additive: no column, no data rewrite. Idempotent: IF NOT EXISTS. Not CONCURRENTLY - the CD
-- migration step runs each file inside a transaction, and the table is small enough for the lock to
-- cost nothing. ROLLBACK: an older image never names the index; dropping it is free.

BEGIN;

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "IDX_post_notifications_recipient_created"
  ON post_notifications ("recipientId", "createdAt" DESC);

COMMIT;
