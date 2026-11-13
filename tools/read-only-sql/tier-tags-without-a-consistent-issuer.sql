-- READ-ONLY. Cotisation tier tags whose issuer is missing or does not match their name.
--
-- A tier tag counts only for the association that issued it (docs/wiki/cotisations.md, "A tag
-- counts only for the association that issued it"). A row written before issuers were recorded has
-- no `issuingAssocId` and is held for nobody; a row whose issuer's slug is not the stem of its name
-- would be read by the wrong association. The wiki says no unissued row exists; this is the count
-- that says so on an estate (docs/wiki/backlog.md, "legacy tier tags without a consistent issuer").
--
-- Run on dev first, then on production with the owner. It writes nothing:
--   BEGIN TRANSACTION READ ONLY; \i tier-tags-without-a-consistent-issuer.sql; ROLLBACK;
-- 0 in every column closes the entry.

SELECT
  COUNT(*) FILTER (WHERE t."issuingAssocId" IS NULL) AS no_issuer,
  COUNT(*) FILTER (WHERE t."issuingAssocId" IS NOT NULL AND a.id IS NULL) AS issuer_gone,
  COUNT(*) FILTER (
    WHERE a.id IS NOT NULL
      AND t."tagName" <> 'cotisant:' || a.slug
      AND t."tagName" NOT LIKE 'cotisant:' || a.slug || '-%'
  ) AS name_not_of_issuer,
  COUNT(*) AS cotisation_tags
FROM user_tags t
LEFT JOIN associations a ON a.id = t."issuingAssocId"
WHERE t."tagName" LIKE 'cotisant:%';

-- The rows behind a non-zero count, without the holder's id: the tag, its issuer, its expiry.
SELECT
  t."tagName",
  t."issuingAssocId",
  a.slug AS issuer_slug,
  t."expiresAt",
  COUNT(*) AS holders
FROM user_tags t
LEFT JOIN associations a ON a.id = t."issuingAssocId"
WHERE t."tagName" LIKE 'cotisant:%'
  AND (
    t."issuingAssocId" IS NULL
    OR a.id IS NULL
    OR (t."tagName" <> 'cotisant:' || a.slug AND t."tagName" NOT LIKE 'cotisant:' || a.slug || '-%')
  )
GROUP BY t."tagName", t."issuingAssocId", a.slug, t."expiresAt"
ORDER BY holders DESC;
