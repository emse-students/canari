-- Migration 132 : a named reader's switch "voit les commentaires" (owner, 2026-11-04).
--
-- docs/wiki/profiles-and-access.md, "The nominative read grants - the decisions" (the 2026-11-04
-- amendment of decisions 2 and 4). A named reader who sees an association, list or institution post
-- ONLY through a read grant (migration 078) no longer sees its comments - the students' own
-- expression, like their personal posts - nor who reacted or voted what, unless a global admin turns
-- this switch on for that person. One switch per PERSON, not per cell: it says what the person may
-- read, wherever their cells reach.
--
-- 1. `read_grant_readers`: one row per named reader whose switch was ever set. NO ROW IS OFF, and
--    OFF is the default for new and existing named readers alike - so no existing grantee needs a
--    row, and none is written here. The predicate is `readerSeesGrantCommentsSql`
--    (`spaces/reader-spaces.ts`).
-- 2. `read_grant_journal` gains the two actions of that switch, `cmt_show` and `cmt_hide` (they fit
--    its `varchar(8)`), which name no cell: `campus` becomes NULL for them, and only for them. The
--    journal stays append-only and records CHANGES only (the service writes no line for a state
--    already held).
--
-- ADDITIVE: a new table, a relaxed NOT NULL, a check constraint replaced by a wider one.
-- Idempotent for CD: IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before each ADD CONSTRAINT.
-- LOCKS: ACCESS EXCLUSIVE on `read_grant_journal` (a few hundred rows at most, written by a global
-- admin's clicks) for the ALTERs and the validation of the two checks, released at COMMIT. A request
-- holding it makes the migration give up after 5 s rather than queue (the re-run is safe).

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS read_grant_readers (
  user_id varchar(255) PRIMARY KEY,
  sees_comments boolean NOT NULL DEFAULT false,
  updated_by varchar(255) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE read_grant_journal ALTER COLUMN campus DROP NOT NULL;

ALTER TABLE read_grant_journal DROP CONSTRAINT IF EXISTS read_grant_journal_action_check;
ALTER TABLE read_grant_journal ADD CONSTRAINT read_grant_journal_action_check
  CHECK (action IN ('grant', 'revoke', 'cmt_show', 'cmt_hide'));

-- A cell line names its campus; a switch line names none.
ALTER TABLE read_grant_journal DROP CONSTRAINT IF EXISTS read_grant_journal_campus_check;
ALTER TABLE read_grant_journal ADD CONSTRAINT read_grant_journal_campus_check
  CHECK ((action IN ('grant', 'revoke')) = (campus IS NOT NULL));

COMMIT;
