-- Migration 001 : personal user notepad (plaintext, never exposed in public DTOs)
-- In non-production TypeORM synchronize also adds this column; this migration
-- covers production where synchronize is disabled.

ALTER TABLE users ADD COLUMN IF NOT EXISTS notes TEXT;
