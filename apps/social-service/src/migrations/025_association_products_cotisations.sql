-- Migration 025: multi-tier cotisations and pricing (WP-COT-1, WP-COT-2).
-- Adds tier registry, member pricing, and required-tags columns to `association_products`
-- so an association can define more than one cotisation product (e.g. Le Cercle's
-- "avec-alcool"/"sans-alcool" forfaits) instead of the single implicit association-wide tag.
-- All columns are nullable and default to NULL – existing single-tier products are unaffected.
-- Column names are quoted camelCase to match TypeORM's default naming strategy (see migration 008).
-- Idempotent via IF NOT EXISTS.

BEGIN;

-- Named cotisation tier this product grants (suffixed onto the derived tag by deriveCotisationTag).
ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "variantKey" VARCHAR(100);

-- Ordinal rank among an association's tiers, for future "tier >= N" optional-inclusion checks (WP-COT-8).
ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "variantLevel" INTEGER;

-- Tier upgrade pricing (WP-COT-2): names the specific sibling tier's tag that qualifies a buyer
-- for the reduced `amountCentsMember` price (the "pay the difference" lever), instead of falling
-- back to the generic asso-wide cotisant check.
ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "memberPriceTag" VARCHAR(100);

-- Required tags for purchasing this product.
ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "requiredTags" TEXT[];

COMMIT;
