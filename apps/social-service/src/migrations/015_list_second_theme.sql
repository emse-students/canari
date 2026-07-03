-- Migration 015: optional second theme for promo lists.
-- Some lists run two themes at once (two names + two logos). These columns are
-- list-only and always optional; associations leave them NULL. Idempotent.

BEGIN;

-- Second theme display name (shown alongside the primary name on the list detail page).
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "name2" VARCHAR(255);

-- Second theme logo: media-service UUID, served at /api/media/public/:id.
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "logoMediaId2" UUID;

COMMIT;
