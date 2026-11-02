-- Migration 018: what an MLS push tells Google and Apple - the server's switch for the
-- content-free wake-up push (owner, 2026-11-02;
-- docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md).
--
--   full  every push carries what it always has: the conversation and sender ids, the names on a
--         visible frame, the kinds, the inline ciphertext. The default, so every existing row -
--         production's and dev's - keeps today's behaviour until a global admin moves it at
--         `/admin/platform`.
--   wake  a push to a device whose registration declared it understands one
--         (`push_token."wakeCapable"`, chat-delivery migration 045) carries only `type`,
--         `queuedMessageId` and `silent`; the device fetches the rest from `GET /mls/push/wake`.
--
-- Read by chat-delivery-service on every MLS push that has a capable destination
-- (`utils/push-mode.ts`), never cached. Not published to clients: nothing on a device decides
-- anything from it - the push it receives says which shape it is.
--
-- A mode rather than a boolean, as `calls_mode` and `lives_mode`.
--
-- ADDITIVE ONLY: a column with a default, and a CHECK so a value no service understands cannot be
-- written by hand. A release that predates this column never reads it, so a rollback is safe.
--
-- Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS push_mode VARCHAR(16) NOT NULL DEFAULT 'full';

ALTER TABLE platform_config DROP CONSTRAINT IF EXISTS "CHK_platform_config_push_mode";
ALTER TABLE platform_config
  ADD CONSTRAINT "CHK_platform_config_push_mode"
  CHECK (push_mode IN ('full', 'wake'));
