-- Migration 011 : association shared notepad (vault-encrypted)
-- Stores opaque AES-256-GCM ciphertext (base64) of the admin notepad.
-- In non-production TypeORM synchronize also adds this column; this migration
-- covers production where synchronize is disabled.

ALTER TABLE associations ADD COLUMN IF NOT EXISTS "notesCiphertext" TEXT;
