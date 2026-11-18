-- Migration 175 : a won ranked Minesweeper game keeps its timed move log, for a moderator to replay.
--
-- docs/wiki/frontend/modules/minesweeper.md, "The replay". A score used to keep only its time and its
-- number of moves: a cheat the server's replay let through (a solver driving the real board, a pace no
-- hand can hold) left nothing to look at. The client now timestamps every dig and flag, the server
-- checks the log ends where the game did, and the log is stored here so a global admin can watch the
-- game back at its own pace.
--
-- ONE ROW PER SCORE, in its own table: the score is read by the leaderboard, the ranks and `me` on
-- every request and a log of a few hundred moves must not ride along. ON DELETE CASCADE: removing a
-- score (a moderator's, or an account's erasure) removes its replay - nothing here outlives the win it
-- documents.
--
-- ADDITIVE and plain (not held): a new table, nothing existing is altered. Idempotent for CD.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS minesweeper_replays (
  "scoreId" uuid PRIMARY KEY REFERENCES minesweeper_scores(id) ON DELETE CASCADE,
  -- [{ "type": "reveal" | "flag", "x": 0, "y": 0, "t": 0 }, ...], t in ms from the first dig.
  moves jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
