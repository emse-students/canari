-- Adds per-channel push notification levels to workspace members (all | mentions | none).
-- The jsonb map is keyed by channelId; an absent channel defaults to 'all'.
-- With synchronize=true (non-production) TypeORM also adds this column; this migration
-- covers production where synchronize is disabled.

ALTER TABLE channel_members
  ADD COLUMN IF NOT EXISTS "notifLevels" jsonb NOT NULL DEFAULT '{}'::jsonb;
