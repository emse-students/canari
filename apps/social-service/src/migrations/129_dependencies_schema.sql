-- canari:hold-for-owner - WP-D1 schema of the spaces-and-audiences reform (owner's yes, 2.2/2.7).
-- Migration 129 : the dependency axis - a display-only label column and the dependency journal.
--
-- docs/wiki/spaces-and-audiences-reform.md, sections 2.2 and 2.7 (WP-D1). ADDITIVE: nothing reads
-- either object for governance yet.
--
-- 1. `associations."displayParentAssociationId"` (G3): the link of a list made "for the BDS" or "for
--    the BDA" - bodies that govern no space - kept as a LABEL ("liste pour le BDS") that grants no
--    right. The governing parent stays `"parentAssociationId"`, which migration 131 binds to a BDE.
--    A loose uuid, like every reference column of this table (no foreign key).
-- 2. `dependency_journal` (2.7, the shape of `read_grant_journal`, migration 078): one append-only
--    line per change of a governing parent (`subject_kind = 'entity'`), of a space's governor
--    (`subject_kind = 'space'`) or of a list's G3 label (`subject_kind = 'label'`; display only, but
--    a platform admin's act all the same), written in the transaction of the change. `actor` is the platform
--    admin's user id, or NULL for a line written by a migration (130), which says so in `source`.
--
-- Idempotent for CD: IF NOT EXISTS everywhere.
-- LOCKS: ACCESS EXCLUSIVE on `associations` for the ADD COLUMN (metadata only: a nullable column
-- with no default rewrites nothing), released at COMMIT; `dependency_journal` is new. A request
-- holding `associations` makes it give up after 5 s rather than queue (the re-run is safe).

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE associations ADD COLUMN IF NOT EXISTS "displayParentAssociationId" uuid NULL;

CREATE TABLE IF NOT EXISTS dependency_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind varchar(8) NOT NULL CHECK (subject_kind IN ('entity', 'space', 'label')),
  subject_id uuid NOT NULL,
  from_id uuid NULL,
  to_id uuid NULL,
  actor varchar(255) NULL,
  source varchar(32) NOT NULL DEFAULT 'admin',
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dependency_journal_subject ON dependency_journal (subject_id, at DESC);

COMMIT;
