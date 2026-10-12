-- Migration 081 : a form that has submissions is ARCHIVED, never removed, and a submission can no
-- longer name a form that does not exist.
--
-- `submissions.formId` had no foreign key, so deleting a form orphaned its submissions (29 on prod
-- and dev, 5 of them paid: the payers' records, nameless). A CASCADE would delete paid rows, so the
-- key is RESTRICT and the application archives instead (`forms."deletedAt"`): the form leaves every
-- list and every respondent flow, its submissions stay readable by staff. A form with NO submission
-- is still hard-deleted. No tombstone rows are created.
--
-- DO NOT DEPLOY BEFORE THE ORPHANS ARE DELETED. The block below RAISES, on purpose and with the
-- count, when any submission still points at a missing form: a deploy that hit it fails loudly
-- rather than leaving the key unadded. Inventory: docs/wiki/backlog.md.
--
-- Idempotent for CD: IF NOT EXISTS / a catalogue check everywhere.

ALTER TABLE forms ADD COLUMN IF NOT EXISTS "deletedAt" timestamptz;

DO $$
DECLARE
  orphans integer;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'submissions_form_fk') THEN
    RETURN;
  END IF;

  SELECT count(*) INTO orphans
  FROM submissions s
  WHERE NOT EXISTS (SELECT 1 FROM forms f WHERE f.id = s."formId");

  IF orphans > 0 THEN
    RAISE EXCEPTION 'migration 081 refused: % submission(s) point at a form that no longer exists. Delete these orphans first (see docs/wiki/backlog.md, "orphan submissions"), then redeploy.', orphans;
  END IF;

  ALTER TABLE submissions
    ADD CONSTRAINT submissions_form_fk FOREIGN KEY ("formId") REFERENCES forms (id) ON DELETE RESTRICT;
END
$$;
