-- Migration 106: every stored association logo URL brought inside the allowlist the service now
-- enforces on write (apps/social-service/src/associations/association-image-url.ts).
--
-- The upload path has only ever written `/api/media/public/<media id>?v=<n>`, and no client sends
-- `logoUrl` in a create or update body. A row outside the allowlist was therefore written by hand
-- or by an API call; it is rewritten to its own uploaded media when it has one, and cleared
-- otherwise. A row already inside the allowlist is not touched.
--
-- The two patterns below MUST stay equal to OWN_MEDIA_REFERENCE and the https branch of
-- isAllowedAssociationImageUrl.
--
-- DATA CHANGE: applying it to an estate waits for the user's yes. Idempotent: a second run matches
-- no row.

UPDATE associations
SET "logoUrl" = CASE
  WHEN "logoMediaId" IS NOT NULL THEN '/api/media/public/' || "logoMediaId"::text
  ELSE NULL
END
WHERE "logoUrl" IS NOT NULL
  AND NOT (
    "logoUrl" ~ '^/api/media/public/[A-Za-z0-9-]{1,64}(\?v=[0-9]{1,20})?$'
    OR (
      length("logoUrl") <= 2048
      AND "logoUrl" ~* '^https://'
      AND "logoUrl" !~ '[[:space:]"''<>`\\]'
    )
  );
