-- Migration 050: a form names a cotisation TIER, never a tag string.
--
-- `pricingTagName`, `grantedTagName` and `tagExpiresAt` stored a literal tag on the form, computed
-- by whoever filled the admin screen. Three things are wrong with a literal, and all three are
-- silent:
--
--   * A dated cotisation's tag carries the academic year. A form configured in June stores
--     `cotisant:bde-2025-2026`; submitted in October it grants a tag for a year that is over.
--     `provisionCotisationProduct` resyncs the association's products on every slug/mode change -
--     nothing resyncs a form, and nothing ever could: the form does not record which tier it meant.
--   * A literal cannot name a TIER, so a multi-tier association got the base tag or a hand-typed
--     guess - the "cotisant nobody can see" that `grantCotisant` refuses to mint.
--   * Granting a raw tag bypasses `revokeSiblingTierTags`, so a user could hold two tiers at once
--     by buying one in the boutique and the other through a form.
--
-- Storing the REFERENCE (which tier) instead of the RESULT (which tag) makes all three impossible:
-- the tag is derived at grant time by `deriveCotisationTag`, from the association's own slug and
-- mode, exactly as every other cotisation path already does.
--
-- The three columns are dropped rather than shimmed because production held no user of them:
-- 1 form, 0 with a granted tag, 0 with a member-price tag (measured 2026-08-23).
-- Idempotent for CD.

BEGIN;

-- Which tier a paid submission grants. NULL = the base, un-suffixed tier, exactly as in
-- `grantCotisant(assocId, userId, grantedBy, variantKey)` - which is why the boolean is needed to
-- tell "grants the base tier" from "grants nothing".
ALTER TABLE forms ADD COLUMN IF NOT EXISTS "grantsCotisation" boolean NOT NULL DEFAULT false;
ALTER TABLE forms ADD COLUMN IF NOT EXISTS "cotisationVariantKey" varchar(100);

-- Whether the form has a member price at all - the faithful replacement for "pricingTagName is
-- set", which is what used to enable BOTH `basePriceMember` and every item's
-- `priceModifierMember`. Deriving it from `basePriceMember != null` instead would silently drop
-- the member price of a form that discounts only its options.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS "memberPriceEnabled" boolean NOT NULL DEFAULT false;

-- Which tier qualifies for the member price. NULL means ANY tier of the beneficiary association -
-- the one deliberate difference from `cotisationVariantKey` above, and the useful default:
-- "who counts as a member" is a question about a SET of tiers, while a grant is exactly one.
ALTER TABLE forms ADD COLUMN IF NOT EXISTS "memberPriceVariantKey" varchar(100);

ALTER TABLE forms DROP COLUMN IF EXISTS "pricingTagName";
ALTER TABLE forms DROP COLUMN IF EXISTS "grantedTagName";
ALTER TABLE forms DROP COLUMN IF EXISTS "tagExpiresAt";

COMMIT;
