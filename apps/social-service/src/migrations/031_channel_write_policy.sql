-- Migration 031: adds the per-channel write policy (who may post).
-- Values: 'everyone' (default), 'admins_moderators', 'admins'. Reading is unaffected.
-- Column is double-quoted camelCase to match TypeORM's default naming (see migration 029).
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when the column already exists.

BEGIN;

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS "writePolicy" VARCHAR(32) NOT NULL DEFAULT 'everyone';

COMMIT;
