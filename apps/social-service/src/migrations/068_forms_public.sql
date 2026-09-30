-- A public form (user request, 2026-09-30): answerable WITHOUT an account, from a link shared
-- outside Canari. A guest's answer is a submission with no `userId`, which migration 067 already
-- allows, so this is one flag and nothing else.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS "isPublic" boolean NOT NULL DEFAULT false;
