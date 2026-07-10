-- Migration 016: cotisations rework - member-gating/pricing on products, cotisation config on
-- associations. The `association_products` and `associations` tables are created by TypeORM
-- synchronize with the default naming strategy (quoted camelCase columns), so new columns are
-- quoted to match (see migration 008). All statements use IF NOT EXISTS so this script is
-- idempotent.

BEGIN;

-- Product-level member gating and member pricing (mirrors forms' pricingTagName/basePriceMember).
ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "membersOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "amountCentsMember" INTEGER;

-- Association-level cotisation config: whether dues are enabled, and their validity mode
-- ('lifetime' or 'dated'). Price/label live on the canonical membership product, not here.
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "cotisationEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "cotisationMode" VARCHAR(20);
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "cotisationExpiresAt" TIMESTAMPTZ;

-- Defensive backfill: the feature is unused in production, so this is essentially free. Any
-- stray existing `membership` product marks its owning association as cotisation-enabled.
-- No tag rewriting: existing grantedTagName/tagExpiresAt values are left untouched.
UPDATE associations a
SET "cotisationEnabled" = true
WHERE a."cotisationEnabled" = false
  AND EXISTS (
    SELECT 1 FROM association_products p
    WHERE p."associationId" = a.id AND p."type" = 'membership'
  );

COMMIT;
