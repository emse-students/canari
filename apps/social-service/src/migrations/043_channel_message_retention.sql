-- Migration 043: the indexes the one-year retention window needs, and nothing else.
--
-- `channel_messages` gained a retention window on 2026-08-19 (365 days, pinned exempt - see
-- `ChannelRetentionScheduler` and docs/wiki/protocols/channel-encryption.md). No column changes:
-- the window is read off `createdAt` and `pinned`, both of which already exist. What is missing is
-- the access paths for the two queries it adds, and the table carried exactly one index
-- (`channelId`) before this.
--
-- 1. The nightly purge scans for `createdAt < cutoff AND pinned = false`. A PARTIAL index on the
--    unpinned rows is the right shape twice over: pinned rows are never the target, and excluding
--    them keeps the index off the one set of rows that stays for ever.
--
-- 2. `liveGraineSessions` - the question a device asks to learn which of its Graine seeds still
--    open something - looks up by `senderSessionId`, scoped to the caller's communities. It runs on
--    every device boot, so a sequential scan here is a scan per launch. The column is nullable (a
--    pre-Graine row has none) and a NULL session answers no device's question, so the index is
--    partial on that too.
--
-- Idempotent: IF NOT EXISTS on both. Not CONCURRENTLY - the CD migration step runs each file inside
-- a transaction, and the table is empty at the time this ships (THE CUT deleted every community on
-- 2026-08-18), so the lock costs nothing.

BEGIN;

CREATE INDEX IF NOT EXISTS "IDX_channel_messages_retention"
  ON channel_messages ("createdAt")
  WHERE pinned = false;

CREATE INDEX IF NOT EXISTS "IDX_channel_messages_sender_session"
  ON channel_messages ("senderSessionId")
  WHERE "senderSessionId" IS NOT NULL;

COMMIT;
