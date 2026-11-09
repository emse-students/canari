-- Migration 160 : campus trends (engagement WP-10, decision 5c).
--
-- docs/wiki/engagement.md, "(c) campus trends". A post takes off when the number of distinct
-- accounts that reacted to or commented on it reaches TREND_THRESHOLD (4, R1 read 2026-11-09) within
-- 24 hours of its `publishedAt`; the write that crosses stamps `trendAnnouncedAt` in the same
-- statement (`WHERE "trendAnnouncedAt" IS NULL`, the `lives."announcedAt"` pattern), so a post
-- takes off at most once, and its space is told once (`post_engagement_notices`, migration 159).
--
-- No backfill: a post published before this column existed has NULL, and only a post that crosses
-- within 24 hours of its publication is ever stamped - a post older than a day never is.
--
-- ADDITIVE: a nullable column with no default, a catalogue change only (no rewrite). Idempotent for
-- CD: IF NOT EXISTS. LOCKS: a brief ACCESS EXCLUSIVE on `posts`, bounded by lock_timeout.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS "trendAnnouncedAt" timestamptz;

COMMIT;
