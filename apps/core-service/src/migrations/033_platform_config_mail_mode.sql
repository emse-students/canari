-- Migration 033: whether the Mail tab (the school mailbox inside Canari) is shown - decision D12 of
-- the mail client: a server switch, off by default, published to clients like the others, dev first
-- and then production.
--
--   off  the Mail tab is hidden for everyone. The default, so every existing row - production's and
--        dev's - keeps today's behaviour until a global admin moves it at `/admin/platform`.
--   on   the Mail tab is shown to eligible accounts (an address on etu.emse.fr or emse.fr).
--
-- A DISPLAY switch only, published to clients by `GET /api/version` (`mail.mode`). It does NOT gate
-- the web relay, which is chat-gateway's own environment flag `MAIL_RELAY_ENABLED`.
--
-- A mode rather than a boolean, as `calls_mode`, `lives_mode`, `push_mode` and `live_replays_mode`.
--
-- ADDITIVE ONLY: a column with a default, and a CHECK so a value no service understands cannot be
-- written by hand. A release that predates this column never reads it, so a rollback is safe.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS mail_mode VARCHAR(16) NOT NULL DEFAULT 'off';

ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_mail_mode";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_mail_mode"
  CHECK (mail_mode IN ('off', 'on'));
