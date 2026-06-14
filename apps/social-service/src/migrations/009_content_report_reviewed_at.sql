-- Migration 009: timestamp of when a content report was handled (reviewed/dismissed).
-- Enables auto-purging handled reports after a delay so the moderation queue and the
-- DB don't accumulate stale entries. Quoted camelCase to match TypeORM's default
-- naming on this table (see migration 003). Idempotent.

BEGIN;

ALTER TABLE content_reports ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMPTZ;

COMMIT;
