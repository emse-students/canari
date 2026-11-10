-- Migration 163 : one counter row per reader per Paris week of campus trends (owner, 2026-11-10).
--
-- docs/wiki/engagement.md, "The owner's decisions of 2026-11-10 - quieter (1.6.10)". A reader is told
-- of at most ONE campus trend a Paris day and TWO a Paris week (Monday to Sunday). Both bounds are
-- read from this row, under its own lock, in the one statement that tells a trend
-- (`campusTrendWeekClaimSql`): `told` counts the week's trends, `"lastDay"` is the day of the latest
-- one. A new week is a new row; nothing resets anything.
--
-- WHY A ROW AND NOT THE LEDGER: counting the told-once ledger's `"trendDay"` rows was exact only
-- for the days before today, and those rows go with their POST (ON DELETE CASCADE) - a deleted post
-- would give its reader a third trend that week. This row names no post, so a deletion frees
-- nothing, and two posts crossing at once for the same reader are ordered by its lock.
--
-- No backfill: a reader told of a trend earlier this week (1.6.9) starts at zero - at most two more
-- this week, once.
--
-- ADDITIVE and plain (not held): one new table. Idempotent for CD (IF NOT EXISTS). Erased with the
-- account (`account-erasure.ts`), and the daily GC deletes the weeks older than two.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS campus_trend_weeks (
  "userId"  varchar(255) NOT NULL,
  week      date         NOT NULL,
  told      integer      NOT NULL CHECK (told > 0),
  "lastDay" date         NOT NULL,
  PRIMARY KEY ("userId", week)
);

COMMIT;
