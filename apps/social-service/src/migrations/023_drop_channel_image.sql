-- Migration 023: drop the per-channel avatar column
-- Channels no longer support a cover image (product decision: channel UI shows name only).
-- Community/workspace avatars are unaffected (channel_workspaces.imageMediaId stays).

BEGIN;

ALTER TABLE channels DROP COLUMN IF EXISTS "imageMediaId";

COMMIT;
