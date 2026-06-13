-- Adds the `pinned` flag to channel messages (Discord-style pinned messages).
-- With synchronize=true (non-production) TypeORM also adds this column; this migration
-- covers production where synchronize is disabled.

ALTER TABLE channel_messages
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
