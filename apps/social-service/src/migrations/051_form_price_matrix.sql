-- Migration 051: a form prices on a MATRIX, not on one member/non-member pair.
--
-- 050, three days old, gave a form two prices: the public one and the cotisant one. What was
-- actually needed is discrimination on several criteria at once - the user's example being a BDE
-- cotisation whose price depends on the chosen menu, the formation AND the promotion.
--
-- The shape is the user's own correction, and it is why this is a matrix rather than an ordered list
-- of price rules: checking the "filtrer par..." boxes describes a grid that has to be entirely
-- filled, so exactly one cell applies to any person. A rule list needs a priority order and an
-- answer for "what if two rules match"; a partition cannot have a tie. There is therefore no
-- tie-break anywhere in this feature, and no order that decides money.
--
-- What a dimension stores is a PARTITION - the buckets the manager cares to distinguish - and the
-- "everyone else" bucket is GENERATED at evaluation time, never stored. That is what keeps four
-- criteria from becoming ninety cells, and what guarantees nobody is unpriced: a null formation, a
-- track Authentik invents next year, a non-cotisant, a promo outside every bucket and an unanswered
-- question all land in it.
--
-- A promo bucket holds either graduation years or a distance from graduation, and says which. The
-- second is the one a form reused every year needs, and it exists for the same reason 050 dropped
-- the stored tag: a bucket saying "promo 2029" is right this year and wrong the next. There is
-- deliberately no "study year" mode - "1A" needs a cursus length, and nothing in this platform
-- knows one (ICM and ISMIN run three years, Master two, no column records it).
--
-- The member-price columns 050 added are dropped and folded into a one-dimension cotisation matrix:
-- two mechanisms for "some people pay less" is the gas factory this module was cleaned out of. Free
-- to do now - production holds 1 form, with `memberPriceEnabled` false and `basePriceMember` null
-- (measured 2026-08-23) - and it would cost a compatibility shim in a year.
-- Idempotent for CD.

BEGIN;

-- The grid: `{ dimensions: [...], cells: { "<bucketId>|<bucketId>": cents } }`.
-- NULL means the form has no grid at all and `basePrice` is the only price, which is what every
-- existing form is and why this migration changes no behaviour on its own.
--
-- Completeness is enforced in `assertMatrixValid` at save time, not by a constraint: the invariant
-- is "one price per combination of the buckets THIS document declares", which no column check can
-- express. A cell missing at read time is refused rather than defaulted - charging a plausible
-- number is how a wrong price ships quietly.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS "priceMatrix" jsonb;

-- Who may submit at all, as the same bucket predicate the grid is built from: AND across the
-- criteria present, no criterion meaning no restriction. One predicate serves the price, a
-- question's visibility and this; writing it three times is how the three come to disagree.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS "submitCondition" jsonb;

-- Folded into a cotisation dimension. `basePriceMember` and each item's `priceModifierMember` go
-- with them - a cell IS the base price for its combination.
ALTER TABLE forms DROP COLUMN IF EXISTS "memberPriceEnabled";
ALTER TABLE forms DROP COLUMN IF EXISTS "memberPriceVariantKey";
ALTER TABLE forms DROP COLUMN IF EXISTS "basePriceMember";

COMMIT;
