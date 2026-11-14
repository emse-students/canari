-- Migration 025: the retention durations a global admin sets (owner, 2026-11-14: "every retention
-- duration becomes a platform admin setting, and the privacy policy renders the values in force from
-- the same source, so they can never disagree; a lowered duration applies to new content only";
-- docs/wiki/retention-settings.md).
--
--   retention_reel_days         a feed CanaReel (`posts.kind = 'reel'`), from its publication.
--   retention_live_replay_days  a live replay (`posts.kind = 'replay'`), from the live's end.
--   retention_chat_reel_days    a CanaReel sent in a conversation (media-service `chat-reel`), from
--                               its upload or its chat hold.
--   retention_idle_media_days   a file sent in a conversation (media-service `ephemeral`), from its
--                               last download.
--
-- Each DEFAULT is the value the code applied before this migration, so every estate keeps today's
-- behaviour until a global admin moves one at `/admin/platform`.
--
-- READ AT CREATION, NEVER AT THE SWEEP: social-service stamps `posts."expiresAt"` from the value in
-- force when the reel or the replay is created, and media-service stamps the due time (or the idle
-- window) on the file's index entry at its upload or hold. So a lowered value applies to new content
-- only, and a raised one too: nothing already stored moves. Published to clients by
-- `GET /api/version` (`retention`), which the privacy policy renders.
--
-- The bounds are a typo guard (a 0 would delete at the next sweep; ten years is beyond any purpose
-- the register states), held here AND by core's DTO, which refuses a value outside them as a 400.
--
-- ADDITIVE ONLY: columns with defaults, and CHECKs. A release that predates these columns never
-- reads them, so a rollback is safe. Idempotent: the deploy ledger replays a file whose predecessor
-- failed mid-run.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS retention_reel_days INTEGER NOT NULL DEFAULT 365;
ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS retention_live_replay_days INTEGER NOT NULL DEFAULT 3;
ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS retention_chat_reel_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS retention_idle_media_days INTEGER NOT NULL DEFAULT 90;

ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_retention_reel_days";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_retention_reel_days"
  CHECK (retention_reel_days BETWEEN 1 AND 3650);
ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_retention_live_replay_days";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_retention_live_replay_days"
  CHECK (retention_live_replay_days BETWEEN 1 AND 365);
ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_retention_chat_reel_days";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_retention_chat_reel_days"
  CHECK (retention_chat_reel_days BETWEEN 1 AND 365);
ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_retention_idle_media_days";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_retention_idle_media_days"
  CHECK (retention_idle_media_days BETWEEN 1 AND 3650);
