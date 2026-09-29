-- Migration 066: how far each member has read each salon - the read receipts a community never had.
--
-- See docs/wiki/services/social-service.md ("Read receipts in a salon").
--
-- A DM's read state travels over MLS as a watermark (one instant per reader, merged as max). A salon
-- has no MLS group, so until now it had no read state at all: `POST :id/read` only dismissed this
-- account's own notifications, and a sender never learned who had read them. The same watermark is
-- now kept here, on the MEMBERSHIP row, keyed by channel id like `notifLevels` beside it - so it
-- goes when the membership goes (leave, kick, account deletion) with nothing else to purge.
--
-- The value is a message's server `createdAt` in epoch milliseconds, which is exactly what a salon
-- message's timestamp is on every client, so the watermark and the list it describes cannot order
-- differently. Only ever raised, in one statement (see `advanceChannelReadMark`).
--
-- Idempotent via IF NOT EXISTS.

BEGIN;

ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS "readMarks" JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
