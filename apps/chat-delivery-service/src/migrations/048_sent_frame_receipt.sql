-- Migration 048: dm_sent_frame_receipt, one row per application frame a sender named by its
-- messageId (2026-11-13).
--
-- A native background send (the notification quick reply, an outbox drain while the app is shut)
-- reads an answer later than its 10 s readTimeout as a failure, keeps the entry and sends the SAME
-- messageId again - a fresh MLS ciphertext each time, so the queue held two copies of one message
-- and every receiver decrypted both. The send route now records (groupId, senderId, senderDeviceId,
-- messageId) in the transaction that queues the copies; a second send of the id finds the row,
-- queues nothing, appends nothing to the history stream, pushes nobody, and is answered with the
-- first copy's receive time. Durable state, never a clock. "protoSha256" names the first copy's
-- exact ciphertext (its queued rows and history entry carry it), and "settled" says whether the send
-- that wrote the row finished delivering it: a repeat of an UNSETTLED one (the server died between
-- the commit and the delivery) finishes that delivery for the copies still queued.
-- Mechanism: docs/wiki/services/chat-delivery.md ("A message sent twice under one id is stored once").
--
-- Additive: a new table, no existing row touched, nothing deleted. A frame sent before this ships
-- has no row, so a resend of it is queued as before (once more at most).
-- Bounded: rows older than the retention window are deleted by the hourly queue sweep, with the
-- account by the erasure, and with the group by its purge.
-- Idempotent: CREATE ... IF NOT EXISTS (synchronize creates it in dev; this is for prod).
--
-- LOCK TIMEOUT: creating a table locks no existing one, but the migration still gives up after five
-- seconds rather than queue behind a long transaction on the catalogue; the deploy then fails loudly
-- and a re-run is safe. Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "dm_sent_frame_receipt" (
    "groupId"        UUID NOT NULL,
    "senderId"       VARCHAR(255) NOT NULL,
    "senderDeviceId" VARCHAR(255) NOT NULL,
    "messageId"      VARCHAR(128) NOT NULL,
    "receivedAt"     TIMESTAMPTZ NOT NULL,
    "protoSha256"    CHAR(64) NOT NULL,
    "settled"        BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY ("groupId", "senderId", "senderDeviceId", "messageId")
);

-- The hourly sweep deletes by age; the account erasure deletes by sender.
CREATE INDEX IF NOT EXISTS "IDX_dm_sent_frame_receipt_receivedAt"
    ON "dm_sent_frame_receipt" ("receivedAt");
CREATE INDEX IF NOT EXISTS "IDX_dm_sent_frame_receipt_senderId"
    ON "dm_sent_frame_receipt" ("senderId");
