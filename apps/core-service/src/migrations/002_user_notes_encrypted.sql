-- Migration 002 : encrypt the personal notepad at rest.
-- `notes` (migration 001) held markdown in clear, so anyone reading the database
-- read the notepad - including whatever the user chose to keep in it. It now
-- stores opaque AES-256-GCM ciphertext (base64) under a per-user key, matching
-- what associations already do with `notesCiphertext`.
--
-- `notes` is deliberately NOT dropped here: it is the only copy of a note written
-- before this change, and only the client can encrypt it. The client re-saves it
-- on first load, which clears the column row by row.
-- In non-production TypeORM synchronize also adds these columns; this migration
-- covers production where synchronize is disabled.

ALTER TABLE users ADD COLUMN IF NOT EXISTS "notesCiphertext" TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "notesKey" VARCHAR;
