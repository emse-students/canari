-- Migration 014: the server's kill switch for calls (B12, WP-C13 - owner, 2026-10-21).
--
-- WHY. Calls are compiled into the store binaries the day `CALLS_COMPILED` flips, and a binary
-- cannot be recalled: without a switch the SERVER holds, stopping calls in production would take a
-- store release on each platform and their review delays. This column is that switch, one row,
-- read on every call request by chat-delivery-service (`utils/calls-mode.ts`) and published to
-- clients through `GET /api/version` so they hide what the server would refuse.
--
--   off          no call may start: initiate, ring, room-token and ice-servers all refuse
--                (`CALLS_DISABLED`). The default, so a fresh row and a production that never opened
--                calls stay closed.
--   audio        1:1 audio calls; a ring that asks for video is refused (`CALLS_VIDEO_DISABLED`).
--                The first production calls are audio only (owner, 2026-10-21).
--   audio_video  audio and video.
--
-- The plan's `testers` value is not here: pre-release builds (the store testers) already talk to
-- the dev estate, whose OWN row holds its own mode, so a third state would duplicate the estate.
--
-- ADDITIVE ONLY: a column with a default, and a CHECK so a value no service understands cannot be
-- written by hand. A release that predates this column never reads it, so a rollback is safe.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS calls_mode VARCHAR(16) NOT NULL DEFAULT 'off';

ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_calls_mode";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_calls_mode"
  CHECK (calls_mode IN ('off', 'audio', 'audio_video'));
