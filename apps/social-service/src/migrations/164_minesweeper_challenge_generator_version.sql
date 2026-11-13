-- Migration 164 : a Minesweeper challenge names the generator it was issued with (owner, 2026-11-13).
--
-- docs/wiki/frontend/modules/minesweeper.md, "Generator v2". The server replays a ranked game on the
-- board it regenerates from (seed, first click), so the generator that made the board is part of the
-- challenge: a challenge issued with generator 1 must be replayed with generator 1 even after the
-- server learns generator 2. `"generatorVersion"` is that name.
--
-- Every existing row is a challenge issued before versions existed, so it is 1 - which is exactly
-- what DEFAULT 1 gives it, with no backfill. A client that does not say which generator it can
-- produce (every build before this one) is issued 1 as well, so nobody is asked to replay what its
-- build cannot make.
--
-- ADDITIVE and plain (not held): one new column with a constant default, which Postgres adds without
-- rewriting the table. Idempotent for CD (IF NOT EXISTS).

SET lock_timeout = '5s';

ALTER TABLE minesweeper_challenges
  ADD COLUMN IF NOT EXISTS "generatorVersion" smallint NOT NULL DEFAULT 1;
