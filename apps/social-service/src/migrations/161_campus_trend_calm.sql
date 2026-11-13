-- Migration 161 : campus trends, calmed (owner, 2026-11-10).
--
-- docs/wiki/engagement.md, "WP-10 - campus trends". When 1.6.9 deployed, every post of the previous
-- 24 hours already past TREND_THRESHOLD took off at its next reaction (five posts in eight minutes,
-- 2483 notifications, 492 readers given five). Two facts make that impossible from now on:
--
-- 1. posts."trendEngagedSeen" - the engaged count the previous trend evaluation READ. A post takes
--    off only at the evaluation that finds the count at or above the threshold when the recorded one
--    was below it (`EVALUATE_TREND_SQL`). A post born after this migration starts at 0 (the default:
--    nobody has engaged with a post being inserted); a post that existed before it is NULL, so its
--    first evaluation records a count and stamps nothing - no deploy, and no change of the threshold,
--    ever announces a backlog.
-- 2. post_engagement_notices."trendDay" and a partial UNIQUE index on (reader, day) - the told-once
--    ledger row of a trend carries its Paris day, so a second trend the same day is a conflict the
--    ledger's own `ON CONFLICT DO NOTHING` skips: ONE campus trend per reader per day, from durable
--    state, never from a timer. Friends' activity rows leave it NULL and are outside the index.
--
-- No backfill: the trend rows written before this migration have no day, so they bind no day; the
-- pre-existing posts are left NULL on purpose (see 1).
--
-- ADDITIVE: two nullable columns (no rewrite: the default is set AFTER the column exists, so it
-- applies to new rows only) and one index on a small table. Idempotent for CD: IF NOT EXISTS, and
-- SET DEFAULT re-runs to the same state. LOCKS: a brief ACCESS EXCLUSIVE on `posts` and on
-- `post_engagement_notices`, bounded by lock_timeout; the index build holds a SHARE lock on the
-- ledger for the time it takes to read it (a few thousand rows).

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE posts ADD COLUMN IF NOT EXISTS "trendEngagedSeen" integer;
ALTER TABLE posts ALTER COLUMN "trendEngagedSeen" SET DEFAULT 0;

ALTER TABLE post_engagement_notices ADD COLUMN IF NOT EXISTS "trendDay" date;
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_post_engagement_notices_trend_day"
  ON post_engagement_notices ("recipientId", "trendDay")
  WHERE "trendDay" IS NOT NULL;

COMMIT;
