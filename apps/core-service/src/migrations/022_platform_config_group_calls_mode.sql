-- Migration 022: whether a GROUP conversation may hold a call - the switch of the peer-to-peer group
-- calls (owner decision D-A, docs/wiki/backlog.d/group-calls-p2p-mesh-up-to-4-audio-3-video-decided-2026-10-31.md).
--
--   off   no group call may start: a group conversation shows no call control, and
--         chat-delivery-service refuses `initiate` for a group with 403 `GROUP_CALLS_DISABLED`.
--         The default, so every existing row - production's and dev's - keeps today's behaviour
--         until a global admin moves it at `/admin/platform`, after the readings.
--   mesh  group calls go peer to peer, up to 4 participants in audio and 3 in video, and are
--         refused past that cap.
--
-- READ BY CHAT-DELIVERY-SERVICE at `initiate`, and published to clients by `GET /api/version` as
-- `calls.groupMode`, so a client hides the control the server would refuse. `calls_mode = off` still
-- closes everything: this switch only narrows what an open `calls_mode` allows, it never widens it.
--
-- A mode rather than a boolean, as `calls_mode`, `lives_mode`, `push_mode`, `checkpoint_skip_mode`
-- and `live_replays_mode`.
--
-- ADDITIVE ONLY: a column with a default, and a CHECK so a value no service understands cannot be
-- written by hand. A release that predates this column never reads it, so a rollback is safe.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS group_calls_mode VARCHAR(16) NOT NULL DEFAULT 'off';

ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_group_calls_mode";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_group_calls_mode"
  CHECK (group_calls_mode IN ('off', 'mesh'));
