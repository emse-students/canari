-- Migration 054: what the OS lets a phone's notifications do, as the phone states it on every
-- `register-device` (2026-11-21; docs/wiki/services/chat-delivery.md, "Registered is not permitted").
--
-- `key_package."notificationState"`: ONE category derived by `parseNotificationState` from what the
-- client read from the OS - `on`, `off` (permission denied or notifications switched off for the
-- app), `not-asked` (iOS: the dialog was never shown), `channel-off` (permitted, but the messages or
-- posts channel is at importance none), `alerts-off` (iOS: permitted, alerts disabled). NULL for a
-- build that does not state it: unknown, never granted.
-- `key_package."notificationChannels"`: the Android channel importances as stated (`messages=high
-- posts=default`), allowlisted; NULL when not stated or not Android.
-- Written on EVERY `register-device`, the stated value or NULL - a row says what its LAST call said.
-- Its one reader is the daily `[PUSH_COVERAGE]` count. No other datum is collected.
--
-- ADDITIVE ONLY: two nullable columns, no default, no backfill. A release that predates them reads
-- nothing of them, so a rollback is safe.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `key_package`. The migration gives up after five
-- seconds rather than queue behind a long transaction; a re-run is safe (idempotent).
SET lock_timeout = '5s';

ALTER TABLE "key_package" ADD COLUMN IF NOT EXISTS "notificationState" varchar(16);
ALTER TABLE "key_package" ADD COLUMN IF NOT EXISTS "notificationChannels" varchar(64);
