-- Migration 157 : the daily cap on engagement pushes (engagement WP-8, decisions 6 and 11).
--
-- docs/wiki/engagement.md, "The noise budget - a daily cap from a counter row". Beyond five
-- engagement pushes per person per Paris day, the rest stay in the in-app bell with no push. ONLY
-- the new kinds are capped (friends' activity, campus trends - `ENGAGEMENT_PUSH_TYPES` in
-- `posts/engagement-push-cap.ts`); nothing that existed before the chantier is ever counted.
--
-- ONE ROW PER (person, Paris day), the primary key: a capped fan-out takes one unit per recipient
-- with ONE `INSERT ... ON CONFLICT DO UPDATE ... WHERE pushed < cap RETURNING`, so the cap is exact
-- under concurrency (the row lock orders two fan-outs on each shared reader). A new day is a new
-- row: nothing resets anything. The daily GC (`FormReminderScheduler`) deletes rows older than
-- 7 days; the account erasure deletes a person's rows (`account-erasure.ts`).
--
-- - `userId`: the recipient. No foreign key: `users` is core-service's table.
-- - `day`: the Paris date, read from the DATABASE's clock at the claim.
-- - `pushed`: how many capped pushes that person was sent that day.
--
-- ADDITIVE: a new table, no existing row read or changed. Idempotent for CD: IF NOT EXISTS. LOCKS:
-- none on an existing table; the migration gives up after 5 s rather than queue.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS engagement_push_days (
  "userId" varchar(255) NOT NULL,
  day      date         NOT NULL,
  pushed   integer      NOT NULL DEFAULT 0 CHECK (pushed >= 0),
  PRIMARY KEY ("userId", day)
);

COMMIT;
