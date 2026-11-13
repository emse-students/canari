-- Migration 158: a CanaReel lives ONE YEAR (owner, 2026-11-09, replacing decision C6's month), and the
-- reels already published move to the year too (docs/wiki/services/reels.md#the-numbers-and-where-each-is-the-one-copy).
--
-- A reel's expiry is a COLUMN, stamped once at publication (`posts."expiresAt"`, migration 069), and
-- the hourly worker deletes a row when that column has passed - so raising `REEL_RETENTION_DAYS` alone
-- would leave every reel published before this release on its month. This re-dates them:
-- `"createdAt" + 365 days`, the stamp `PostsService.create` would have written under the new rule.
--
-- WHAT IT TOUCHES, AND ONLY THAT (an allowlist in the WHERE):
--   - `kind = 'reel'`: never a post (NULL expiry) and NEVER a live replay (`kind = 'replay'`, its own
--     three days from `LIVE_REPLAY_RETENTION_DAYS`, migration 156) - pinned by
--     `reels-one-year-migration.integration.spec.ts`;
--   - `"expiresAt" > now()`: a reel already past its month is dead to every read and may have lost its
--     blob to the worker's purge (a `failed` row kept for the next tick) - extending it would bring
--     back a reel whose video is gone, so it is left to the worker;
--   - `"expiresAt" < "createdAt" + 365 days`: only moves an expiry FORWARD, so a second run changes
--     nothing (idempotent for CD) and a row already on the year is left as it is.
--
-- Data only: row locks on the live reels (a few hundred rows at most), no DDL, so no lock_timeout is
-- owed (`migrations.lock-timeout.spec.ts`). No personal data is added or read.
--
-- ROLLBACK: an older image reads `expiresAt` as stored and deletes these reels a year after
-- publication instead of a month; putting them back on the month is
-- `UPDATE posts SET "expiresAt" = "createdAt" + interval '30 days' WHERE kind = 'reel' AND ...`,
-- which the worker would then reap at its next tick for every reel older than a month.

UPDATE posts
   SET "expiresAt" = "createdAt" + interval '365 days'
 WHERE kind = 'reel'
   AND "expiresAt" > now()
   AND "expiresAt" < "createdAt" + interval '365 days';
