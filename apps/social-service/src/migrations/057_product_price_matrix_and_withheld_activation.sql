-- Migration 057: a product prices on a MATRIX, and knows why it is off sale.
--
-- Two columns, one incident each.
--
-- 1. `priceMatrix`. A cotisation cost one number, optionally a second one for holders of a sibling
--    forfait (`memberPriceTag` + `amountCentsMember`). What an association actually prices on is
--    the promotion and the formation as well - the same thing migration 051 established for forms,
--    which is why this is the same document evaluated by the same code (`pricing/price-matrix.ts`)
--    rather than a second pricing mechanism. A matrix has no priority rule to get wrong: the cells
--    partition the population, so exactly one applies to any buyer.
--
--    When a grid is set it REPLACES the fixed pricing on that product; the tier-upgrade discount
--    becomes a `cotisation` dimension. The fixed columns are deliberately NOT dropped the way 051
--    dropped the form ones: they are the pricing of every product that has no grid, which is all
--    of them today.
--
-- 2. `activationWithheld`. A product is created inactive when the association cannot yet take
--    payments. Nothing ever activated it afterwards, so the BDE's 170 EUR cotisation sat inactive
--    with a fully onboarded Stripe account behind it - invisible in the boutique, refused at
--    checkout, with no screen anywhere able to turn it on. Measured 2026-08-31: 5 products on
--    prod, 5 inactive, 0 active.
--
--    `isActive = false` could not be the trigger for the repair, because it answers "is this on
--    sale", not "was this withheld for want of an account" - and a repair driven by the first
--    would resurrect every product an admin deliberately took off sale. So the second question
--    gets its own column, and `releaseWithheldProducts` acts on it as an allowlist.
--
-- Idempotent for CD.

BEGIN;

-- The grid: `{ dimensions: [...], cells: { "<bucketId>|<bucketId>": cents | null } }`.
-- NULL means no grid, and `amountCents` is the price - which is what every existing product is,
-- and why this column changes no behaviour on its own. Completeness is a save-time invariant
-- (`assertMatrixValid`), not a constraint: "one price per combination of the buckets THIS document
-- declares" is not something a column check can express.
ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "priceMatrix" jsonb;

-- Why the product is off sale, when it is. The backfill below runs ONCE, guarded on the column not
-- existing yet: replayed after an admin has taken a product off sale by hand, an unguarded UPDATE
-- would mark that product as merely "withheld" and the next onboarding event would put it back on
-- sale. A one-shot backfill that can replay is the trap this repository has already met.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'association_products' AND column_name = 'activationWithheld'
  ) THEN
    ALTER TABLE association_products ADD COLUMN "activationWithheld" boolean NOT NULL DEFAULT false;

    -- Every product inactive at this instant was forced inactive at creation: no screen has ever
    -- been able to deactivate a membership tier, and the boutique's own toggle post-dates none of
    -- these rows. Measured before writing this: 5 inactive, 0 active, 0 ever toggled.
    UPDATE association_products SET "activationWithheld" = true WHERE "isActive" = false;
  END IF;
END $$;

COMMIT;
