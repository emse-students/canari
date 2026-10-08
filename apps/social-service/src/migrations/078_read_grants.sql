-- Migration 078 : nominative read access to the student feed (WP7 of profiles-and-access, D24).
--
-- One row = one named account x one campus x one formation scope (formation NULL = the whole
-- campus). It lets that account READ the posts of the associations, lists and institutions whose
-- audience reaches a space inside the cell, with their comments and reactions, and the events of
-- those associations. NEVER a personal post (the predicate reads posts published AS an entity), and
-- it only ADDS to what the population already gives. No end date: a row lives until it is revoked.
--
-- The journal is append-only: who granted or revoked which cell for whom, and when. Revoking
-- DELETES the grant row and WRITES a journal row in the same transaction, so the list of current
-- grants is the table and the history is the journal. Both are visible to global admins only.
--
-- Idempotent for CD: IF NOT EXISTS everywhere.

CREATE TABLE IF NOT EXISTS read_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(255) NOT NULL,
  campus varchar(32) NOT NULL CHECK (campus IN ('saint-etienne', 'gardanne')),
  formation varchar(16) NULL CHECK (formation IS NULL OR formation IN ('ICM', 'ISMIN', 'FSSS', 'PDIS', 'Autre')),
  granted_by varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A cell is granted once: NULL formation is a value of its own here, which a plain UNIQUE would let repeat.
CREATE UNIQUE INDEX IF NOT EXISTS uq_read_grants_cell
  ON read_grants (user_id, campus, COALESCE(formation, ''));

CREATE INDEX IF NOT EXISTS idx_read_grants_user ON read_grants (user_id);

CREATE TABLE IF NOT EXISTS read_grant_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id varchar(255) NOT NULL,
  campus varchar(32) NOT NULL,
  formation varchar(16) NULL,
  action varchar(8) NOT NULL CHECK (action IN ('grant', 'revoke')),
  actor varchar(255) NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_read_grant_journal_at ON read_grant_journal (at DESC);
