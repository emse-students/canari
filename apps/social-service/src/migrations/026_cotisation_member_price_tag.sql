-- Migration 026: tier upgrade pricing (WP-COT-2). Adds `memberPriceTag` to `association_products`
-- so a tier-upgrade product (e.g. Le Cercle's "avec-alcool") can name the specific sibling tier's
-- tag that qualifies a buyer for the reduced `amountCentsMember` price (the "pay the difference"
-- lever), instead of falling back to the generic asso-wide cotisant check. Nullable, defaults to
-- NULL - existing single-tier/no-tier products are unaffected. Idempotent via IF NOT EXISTS.

BEGIN;

ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "memberPriceTag" VARCHAR(100);

COMMIT;
