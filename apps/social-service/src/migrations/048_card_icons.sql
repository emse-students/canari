-- Migration 048: per-card decorative icons for boutique products and partnership cards.
-- Same uuid-media-id + derived-url column pair as Association.logoMediaId/logoUrl and
-- Form.imageMediaId/imageUrl. Idempotent for CD.

BEGIN;

ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "iconMediaId" uuid;
ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "iconUrl" varchar(500);

ALTER TABLE partnership_cards ADD COLUMN IF NOT EXISTS "iconMediaId" uuid;
ALTER TABLE partnership_cards ADD COLUMN IF NOT EXISTS "iconUrl" varchar(500);

COMMIT;
