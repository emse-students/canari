-- Migration 106: every stored association logo URL brought inside the allowlist the service now
-- enforces on write (apps/social-service/src/associations/association-image-url.ts).
--
-- The upload path has only ever written `/api/media/public/<media id>?v=<n>`, and no client sends
-- `logoUrl` in a create or update body. A row outside the allowlist was therefore written by hand
-- or by an API call; it is rewritten to its own uploaded media when it has one, and cleared
-- otherwise. A row already inside the allowlist is not touched.
--
-- NOTHING IS LOST SILENTLY: before a row is rewritten, its id, its old "logoUrl", its "updatedAt" and
-- the time of the change are copied into `association_logo_url_rewrites` (created here), and the
-- number of rows changed is raised as a NOTICE. A legitimate `http://` logo cleared by this file can
-- be read back from that table; a value that was not a logo is evidence, kept as such.
--
-- The patterns below follow OWN_MEDIA_REFERENCE and the https branch of isAllowedAssociationImageUrl.
-- They are not byte-for-byte the writer's check (it also parses the URL, and JavaScript's `\s` is
-- wider than `[[:space:]]`), but they are AT LEAST AS STRICT AS THE READER: every value kept here is a
-- path or an https URL with no quote, angle bracket, backtick, backslash or whitespace, which the
-- client's imageSrcOrNull draws and its HTML builders escape.
--
-- Applied by the deploy itself (infrastructure/lib/migrations.sh), so merging and releasing IS
-- applying. Idempotent: the audit table is created only once, and a second run matches no row.

CREATE TABLE IF NOT EXISTS association_logo_url_rewrites (
  id bigserial PRIMARY KEY,
  "associationId" uuid NOT NULL,
  "oldLogoUrl" text NOT NULL,
  "newLogoUrl" text,
  "associationUpdatedAt" timestamptz,
  "rewrittenAt" timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE
  changed integer;
BEGIN
  WITH outside AS (
    SELECT
      id,
      "logoUrl" AS old_url,
      CASE
        WHEN "logoMediaId" IS NOT NULL THEN '/api/media/public/' || "logoMediaId"::text
        ELSE NULL
      END AS new_url,
      "updatedAt" AS updated_at
    FROM associations
    WHERE "logoUrl" IS NOT NULL
      AND NOT (
        "logoUrl" ~ '^/api/media/public/[A-Za-z0-9-]{1,64}(\?v=[0-9]{1,20})?$'
        OR (
          length("logoUrl") <= 2048
          AND "logoUrl" ~* '^https://[^/?#]'
          AND "logoUrl" !~ '[[:space:]"''<>`\\]'
        )
      )
  ),
  audited AS (
    INSERT INTO association_logo_url_rewrites
      ("associationId", "oldLogoUrl", "newLogoUrl", "associationUpdatedAt")
    SELECT id, old_url, new_url, updated_at FROM outside
    RETURNING "associationId", "newLogoUrl"
  )
  UPDATE associations a
  SET "logoUrl" = audited."newLogoUrl"
  FROM audited
  WHERE a.id = audited."associationId";

  GET DIAGNOSTICS changed = ROW_COUNT;
  RAISE NOTICE 'migration 106: % association logo URL(s) rewritten, old values kept in association_logo_url_rewrites', changed;
END $$;
