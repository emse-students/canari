-- Migration 079: the access path the unread count needs, and nothing else.
--
-- `ChannelService.listUnreadCounts` counts, per salon, the rows newer than the reader's mark. The
-- table carried one index on `channelId`, so every salon's WHOLE history (365 days of retention) was
-- read to be filtered by date. Measured on a scratch copy, 300 salons and 1.5M rows: 300 ms with a
-- sequential scan, 6 ms once (channelId, createdAt) exists and the query bounds createdAt.
--
-- Idempotent: IF NOT EXISTS. Not CONCURRENTLY - the CD migration step runs each file inside a
-- transaction, and the table is small enough for the lock to cost nothing.

BEGIN;

CREATE INDEX IF NOT EXISTS "IDX_channel_messages_channel_created"
  ON channel_messages ("channelId", "createdAt");

COMMIT;
