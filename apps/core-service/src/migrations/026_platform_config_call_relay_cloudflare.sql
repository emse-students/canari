-- Migration 026: `cloudflare` becomes a value of `platform_config.call_relay` (WP-GC3, owner decision
-- D2 of 2026-11-01: Cloudflare Realtime serves now, call-service is kept working, one setting picks;
-- docs/wiki/frontend/modules/calls.md#the-cloudflare-relay-wp-gc3-server-half-2026-11-16).
--
--   cloudflare    Cloudflare Realtime's SFU carries a group call from the start, as `call-service`
--                 does (the interim rule of 023, until WP-GC5's mid-call switch). The client never
--                 meets Cloudflare's API: chat-delivery-service proxies the sessions/tracks API with
--                 the app's pair (CLOUDFLARE_SFU_APP_ID / CLOUDFLARE_SFU_APP_SECRET) and signs
--                 `mode: cloudflare` into the room tokens. Set on a server without that pair, a group
--                 call is REFUSED at `initiate` (GROUP_CALL_RELAY_UNAVAILABLE), never carried on the
--                 mesh instead.
--
-- Migration 023 wrote the column and its first CHECK and promised this value to the pull request
-- that builds the leg, never before: a value no service carries cannot be written. This is that
-- pull request. The column, its default (`none`) and every row are untouched.
--
-- ADDITIVE ONLY: the CHECK is re-created WIDER (the drop-and-add idiom of 023), so every value a row
-- can hold today still passes. A release that predates this file never writes `cloudflare`, and a
-- rollback leaves a row at `none` or `call-service` valid under either CHECK; a row set to
-- `cloudflare` before a rollback reads as an unknown value to the older chat-delivery, which REFUSES
-- the group call rather than guessing (`readCallRelay`), so an admin sets the relay back first.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_call_relay";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_call_relay"
  CHECK (call_relay IN ('none', 'call-service', 'cloudflare'));
