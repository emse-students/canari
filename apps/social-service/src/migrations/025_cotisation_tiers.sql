-- Migration 025: multi-tier cotisations (WP-COT-1). Adds a named-tier registry to
-- `association_products` so an association can define more than one cotisation product
-- (e.g. Le Cercle's "avec-alcool"/"sans-alcool" forfaits) instead of the single implicit
-- association-wide tag. Both columns are nullable and default to NULL, which is the existing
-- single-tier form - behavior is unchanged until a product actually sets `variantKey`.
-- Column names are quoted camelCase to match TypeORM's default naming strategy (see migration 008).
-- Idempotent via IF NOT EXISTS.

BEGIN;

-- Named cotisation tier this product grants (suffixed onto the derived tag by deriveCotisationTag).
ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "variantKey" VARCHAR(100);

-- Ordinal rank among an association's tiers, for future "tier >= N" optional-inclusion checks (WP-COT-8).
ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "variantLevel" INTEGER;

COMMIT;
