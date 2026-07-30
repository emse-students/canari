-- Migration 035 : publication of a "Carte de la Vie Asso" poster to the public showcase.
--
-- `publication` holds the PUBLISHED artefact, which is deliberately NOT the editor's `layout`:
-- it is a resolved, normalized geometry document (see docs/wiki/carte-vie-asso.md, "Publishing to
-- the Portail") that the portail-etu SPA renders. Keeping the two apart lets the editor rev its
-- own layout schema without breaking the published contract.
--
-- At most one poster may be published at a time: the partial unique index makes that a database
-- invariant rather than a convention, so a concurrent publish can never leave two live maps.
-- Idempotent for CD.

ALTER TABLE poster_projects ADD COLUMN IF NOT EXISTS publication jsonb;
ALTER TABLE poster_projects ADD COLUMN IF NOT EXISTS "publishedAt" timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_poster_projects_single_publication
  ON poster_projects ((publication IS NOT NULL))
  WHERE publication IS NOT NULL;
