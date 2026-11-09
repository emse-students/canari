-- Migration 020: whether a client may skip the MLS checkpoint after a drain that only RECEIVED
-- application frames - the switch of WP-CHECKPOINT-SKIP (decided 2026-11-07 by the lead under the
-- owner's delegation; docs/wiki/open-questions.md, the checkpoint-skip section).
--
--   off  every drain ends with a full encrypted checkpoint of the MLS state, as it always has. The
--        default, so every existing row - production's and dev's - keeps today's behaviour until a
--        global admin moves it at `/admin/platform`, after the dev readings the question lists.
--   on   a live drain that only received application frames leaves its checkpoint to the next
--        trigger that already exists (a send, a commit, the background edge, logout), until 100
--        deferred receive generations are unsaved - a COUNT held by the client, never a clock.
--
-- Read by no service: it is published to clients by `GET /api/version` (`checkpointSkip.mode`),
-- and a client that cannot read it - an older server, no answer yet - stays `off`.
--
-- A mode rather than a boolean, as `calls_mode`, `lives_mode` and `push_mode`.
--
-- ADDITIVE ONLY: a column with a default, and a CHECK so a value no client understands cannot be
-- written by hand. A release that predates this column never reads it, so a rollback is safe.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS checkpoint_skip_mode VARCHAR(16) NOT NULL DEFAULT 'off';

ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_checkpoint_skip_mode";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_checkpoint_skip_mode"
  CHECK (checkpoint_skip_mode IN ('off', 'on'));
