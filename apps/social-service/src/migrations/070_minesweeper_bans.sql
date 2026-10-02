-- Minesweeper moderation (user, 2026-10-02: remove a score, and ban a user): a banned player is out
-- of the RANKED game - they cannot start or submit a challenge, and neither their scores nor their
-- standing appear on the leaderboard, the rank of anyone else or a profile badge.
--
-- A BAN IS A ROW, AND THE SCORES STAY. Nothing is deleted when someone is banned: the leaderboard,
-- the rank query and the standing all ask "is this user banned" at read time, so lifting the ban
-- (DELETE the row) restores everything exactly as it was. A ban that destroyed the scores could not
-- be undone, and a moderator who made a mistake would have no way back.
--
-- Removing ONE score is the other tool, and it is a DELETE of that `minesweeper_scores` row: it needs
-- no table of its own. Idempotent for CD: IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS minesweeper_bans (
  "userId" varchar(255) PRIMARY KEY,
  reason varchar(500) NULL,
  "bannedBy" varchar(255) NOT NULL,
  "bannedAt" timestamptz NOT NULL DEFAULT now()
);
