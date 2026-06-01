-- Migration 003: add columns missing from channels and channel_workspaces
-- These columns were added to TypeORM entities after the initial schema was created.
-- All ALTER TABLE statements use IF NOT EXISTS so this script is idempotent.

BEGIN;

-- channels: nullable masterSecret added 2026-04-05 (HKDF key distribution)
ALTER TABLE channels ADD COLUMN IF NOT EXISTS "masterSecret" TEXT;

-- channels: nullable imageMediaId added 2026-04-11 (workspace/channel avatars)
ALTER TABLE channels ADD COLUMN IF NOT EXISTS "imageMediaId" VARCHAR(255);

-- channels: allowedUsers simple-array added 2026-05-15 (member-based private channel access)
ALTER TABLE channels ADD COLUMN IF NOT EXISTS "allowedUsers" TEXT NOT NULL DEFAULT '';

-- channel_workspaces: nullable imageMediaId added 2026-04-11 (community avatar)
ALTER TABLE channel_workspaces ADD COLUMN IF NOT EXISTS "imageMediaId" VARCHAR(255);

COMMIT;
