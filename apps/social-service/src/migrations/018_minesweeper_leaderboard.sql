-- Ranked Minesweeper challenges + verified scores (anti-cheat replay).
-- Idempotent for CD: IF NOT EXISTS on tables and indexes.

CREATE TABLE IF NOT EXISTS minesweeper_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" varchar(255) NOT NULL,
  seed varchar(64) NOT NULL,
  width int NOT NULL,
  height int NOT NULL,
  "mineCount" int NOT NULL,
  "startedAt" timestamptz NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'open'
);

CREATE INDEX IF NOT EXISTS idx_minesweeper_challenges_user
  ON minesweeper_challenges ("userId");

CREATE INDEX IF NOT EXISTS idx_minesweeper_challenges_status
  ON minesweeper_challenges (status);

CREATE TABLE IF NOT EXISTS minesweeper_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "challengeId" uuid NOT NULL UNIQUE REFERENCES minesweeper_challenges(id),
  "userId" varchar(255) NOT NULL,
  "durationMs" int NOT NULL,
  "moveCount" int NOT NULL,
  "verifiedAt" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_minesweeper_scores_duration
  ON minesweeper_scores ("durationMs" ASC, "verifiedAt" ASC);

CREATE INDEX IF NOT EXISTS idx_minesweeper_scores_user
  ON minesweeper_scores ("userId");
