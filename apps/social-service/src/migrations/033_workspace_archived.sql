-- Migration 033: allows a community (workspace) to be deleted.
-- Soft delete: the row and its members/channels/messages stay, but every read path
-- filters `archived`, so the community disappears for everyone and its slug stays
-- reserved as a tombstone. Recovering one is a single UPDATE.
-- Column is double-quoted camelCase to match TypeORM's default naming (see migration 029).
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when the column already exists.

BEGIN;

ALTER TABLE channel_workspaces
  ADD COLUMN IF NOT EXISTS "archived" BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
