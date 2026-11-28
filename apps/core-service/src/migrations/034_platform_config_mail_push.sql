-- Migration 034: how a new school mail reaches a phone that is not watching - decision D11 of the
-- mail client, lot 5 (docs/wiki/mail-client-transport.md#as-built---lot-5). Owner, 2026-11-28: both
-- paths are wired, and a global admin chooses.
--
--   none        no server takes part. Android keeps lot 4's persistent connection (the user's
--               switch), iOS refreshes when the system allows. The default, so every existing row -
--               production's and dev's - keeps today's behaviour until a global admin moves it at
--               `/admin/platform`.
--   cloudflare  the fast path: the account's own Zimbra new-mail alert is pointed at an opaque
--               address on Cloudflare Email Routing, whose Worker posts only the address's token to
--               chat-delivery-service, which sends an EMPTY push to that account's devices.
--
-- Published to clients by `GET /api/version` (`mail.push`) and READ by chat-delivery-service at the
-- hook (`utils/mail-push.ts`): with `none` the hook pushes nothing.
--
-- A mode rather than a boolean, as `calls_mode`, `push_mode` and `mail_mode`. ADDITIVE ONLY: a
-- column with a default, and a CHECK so a value no service understands cannot be written by hand. A
-- release that predates this column never reads it, so a rollback is safe.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS mail_push VARCHAR(16) NOT NULL DEFAULT 'none';

ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_mail_push";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_mail_push"
  CHECK (mail_push IN ('none', 'cloudflare'));
