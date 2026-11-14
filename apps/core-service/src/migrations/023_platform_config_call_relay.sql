-- Migration 023: which relay carries a GROUP call - the setting of WP-GC4 (owner decision D2,
-- docs/wiki/backlog.d/group-calls-p2p-mesh-up-to-4-audio-3-video-decided-2026-10-31.md).
--
--   none          no relay: a group call is a peer-to-peer mesh (`group_calls_mode = mesh`), and the
--                 participant past the mesh cap is refused. The default, so every existing row -
--                 production's included - keeps today's behaviour.
--   call-service  our Rust SFU (`apps/call-service`, SFU mode) carries the group call, E2E transforms
--                 in the path throughout, so no clear frame ever crosses it. INTERIM RULE (2026-11-13,
--                 reversible): with this value a group call goes through the relay FROM THE START,
--                 until WP-GC5's mid-call switch exists; chat-delivery-service signs `mode: sfu` and
--                 the relay's seat cap into the room tokens.
--
-- `cloudflare` is added to the CHECK by the pull request that builds the Cloudflare leg, never
-- before: a value no service carries cannot be written.
--
-- READ BY CHAT-DELIVERY-SERVICE at a group call's `initiate`, never cached, and published by
-- `GET /api/version` as `calls.relay`. `group_calls_mode = off` and `calls_mode = off` still close
-- what they close: this setting only chooses the path of a group call that is allowed.
--
-- ADDITIVE ONLY: a column with a default, and a CHECK so a value no service understands cannot be
-- written by hand. A release that predates this column never reads it, so a rollback is safe.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS call_relay VARCHAR(16) NOT NULL DEFAULT 'none';

ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_call_relay";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_call_relay"
  CHECK (call_relay IN ('none', 'call-service'));
