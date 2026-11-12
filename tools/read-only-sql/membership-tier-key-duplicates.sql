-- READ-ONLY. The duplicates a unique index on membership tier keys would refuse.
--
-- Proposed (docs/wiki/backlog.md, "a partial unique index on tier keys", 2026-10-26): a partial
-- unique index on association_products ("associationId", "variantKey") WHERE type = 'membership',
-- plus one on ("associationId") WHERE type = 'membership' AND "variantKey" IS NULL for the base
-- tier. The application keeps the key unique under an advisory lock (products.service.ts,
-- assertVariantKeyFree / saveTierWithDerivedKey); nothing in the schema does yet.
--
-- The scope is the application's: every membership product of an association, active or not,
-- compared byte for byte, the base tier's NULL included (GROUP BY groups NULLs together).
--
-- Run on dev first, then on production with the owner. It writes nothing. 0 rows in the first
-- query means the migration can be written as proposed; any row is a duplicate to settle first.
-- Run inside a read-only transaction so a slip cannot write:
--   BEGIN TRANSACTION READ ONLY; \i membership-tier-key-duplicates.sql; ROLLBACK;

-- 1. Every (association, tier key) held by more than one membership product.
SELECT
  "associationId",
  COALESCE("variantKey", '<base tier>') AS tier_key,
  COUNT(*) AS products,
  COUNT(*) FILTER (WHERE "isActive") AS active_products,
  array_agg(id ORDER BY "createdAt") AS product_ids
FROM association_products
WHERE type = 'membership'
GROUP BY "associationId", "variantKey"
HAVING COUNT(*) > 1
ORDER BY products DESC, "associationId";

-- 2. The totals, so the answer is one line when there is nothing to settle.
SELECT
  COUNT(*) AS duplicated_keys,
  COALESCE(SUM(products - 1), 0) AS products_the_index_would_refuse
FROM (
  SELECT COUNT(*) AS products
  FROM association_products
  WHERE type = 'membership'
  GROUP BY "associationId", "variantKey"
  HAVING COUNT(*) > 1
) AS duplicated;
