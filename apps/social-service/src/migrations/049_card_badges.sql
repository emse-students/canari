-- Migration 049: short decorative badge text for boutique products and partnership cards
-- (e.g. "Nouveau", "-20%"), shown as a small pill on the card. Idempotent for CD.

BEGIN;

ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "badgeText" varchar(30);

ALTER TABLE partnership_cards ADD COLUMN IF NOT EXISTS "badgeText" varchar(30);

COMMIT;
