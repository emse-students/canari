-- Migration 021: whether a finished live is kept three days as a replay - the switch of WP-R1 of the
-- live replays (owner, 2026-11-07 and 2026-11-09; docs/wiki/live-replays.md).
--
--   off  a live keeps its newest 20 segments and is deleted at its end, as it always has. The
--        default, so every existing row - production's and dev's - keeps today's behaviour until a
--        global admin moves it at `/admin/platform`, after the texts and the dev readings the design
--        page lists.
--   on   a live STARTED while it is on keeps its last three hours, and its end publishes a replay
--        post that expires three days later.
--
-- READ BY SOCIAL-SERVICE at the START of a live, never later: the answer is fixed on the live row
-- (`lives."keepsReplay"`, social migration 156), so a flip mid-live never makes half a replay, and a
-- flip back to `off` stops new replays without deleting the ones already published. Also published
-- to clients by `GET /api/version` (`liveReplays.mode`), for the pre-live sheet's wording.
--
-- A mode rather than a boolean, as `calls_mode`, `lives_mode`, `push_mode` and `checkpoint_skip_mode`.
--
-- ADDITIVE ONLY: a column with a default, and a CHECK so a value no service understands cannot be
-- written by hand. A release that predates this column never reads it, so a rollback is safe.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS live_replays_mode VARCHAR(16) NOT NULL DEFAULT 'off';

ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_live_replays_mode";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_live_replays_mode"
  CHECK (live_replays_mode IN ('off', 'on'));
