-- Migration 051: what a phone's last push registration came to, as the phone states it on every
-- `register-device` (2026-11-15; docs/wiki/services/chat-delivery.md, "The server's row decides
-- whether a registration is owed").
--
-- `key_package."pushOutcome"`: the client's `PushOutcomeRecord` (`registered`, `no-token`,
-- `unauthorized`, ...), allowlisted by `parsePushOutcome`; NULL for a build that does not state it.
-- Written on EVERY `register-device`, the stated value or NULL - a row says what its LAST call said.
-- Its one reader is the daily `[PUSH_COVERAGE]` count, which tells a phone the OS gives no push token
-- (`no-token`: no Play services, an APNs failure - already accused by `[PUSH_UNAVAILABLE]`, and not
-- curable by re-registering) from a phone that ran and whose registration never reached the server.
--
-- ADDITIVE ONLY: one nullable column, no default, no backfill. A release that predates it reads
-- nothing of it, so a rollback is safe.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `key_package`, which every invitation reads. The
-- migration gives up after five seconds rather than queue behind a long transaction; the deploy then
-- fails loudly and a re-run is safe (idempotent). A nullable column is a catalogue-only change.
SET lock_timeout = '5s';

ALTER TABLE "key_package" ADD COLUMN IF NOT EXISTS "pushOutcome" varchar(32);
