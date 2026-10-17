-- Migration 085: the FILE question of a form (a CV, say) - the files, and how long they are kept.
--
-- See docs/wiki/frontend/modules/forms.md ("The file question").
--
-- A file answer is stored in `submissions.answers` as an opaque id string, like every other answer.
-- What that id names lives HERE, one row per uploaded file: who uploaded it, for which form and which
-- question, what it is (the content type is read from the bytes at upload, never from the client),
-- and the two facts its lifetime is decided from.
--
-- THE STATE IS THE ROW. Nothing else records whether a file is still there:
-- - "submissionId" IS NULL: uploaded and not yet sent with an answer. Attachable for one day after
--   "createdAt", purged (blob, then row) after it. A deleted submission sets it back to NULL, so its
--   file joins the same purge.
-- - "submissionId" set, "purgedAt" NULL: an answer's file, readable by the form's managers, purged
--   "fileRetentionDays" after "attachedAt" (the date of the answer).
-- - "purgedAt" set: the blob is gone and the ANSWER STAYS - the manager reads "file deleted".
--   Written only after the media service said the blob is gone.
--
-- `forms."fileRetentionDays"`: how many days an answer's file is kept, 1 to 30, 7 by default
-- (decisions D23 and D41 of docs/wiki/bookings-chantier.md).
--
-- No foreign key on "formId": a form with no submission is deleted outright (`retireForms`), and its
-- never-sent uploads must stay listed until the purge has taken their blobs - a cascade would delete
-- the only record of them, and a RESTRICT would refuse the form's deletion.
--
-- Idempotent for CD: IF NOT EXISTS / a catalogue check everywhere.

ALTER TABLE forms ADD COLUMN IF NOT EXISTS "fileRetentionDays" integer NOT NULL DEFAULT 7;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'forms_file_retention_days_range') THEN
    ALTER TABLE forms
      ADD CONSTRAINT forms_file_retention_days_range CHECK ("fileRetentionDays" BETWEEN 1 AND 30);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS form_files (
  id uuid PRIMARY KEY,
  "formId" uuid NOT NULL,
  "itemId" varchar(64) NOT NULL,
  "uploaderId" varchar(255) NOT NULL,
  "contentType" varchar(64) NOT NULL,
  "fileName" varchar(255) NOT NULL,
  "sizeBytes" integer NOT NULL,
  "submissionId" uuid NULL,
  "attachedAt" timestamptz NULL,
  "purgedAt" timestamptz NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'form_files_submission_fk') THEN
    ALTER TABLE form_files
      ADD CONSTRAINT form_files_submission_fk FOREIGN KEY ("submissionId")
      REFERENCES submissions (id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS form_files_form_idx ON form_files ("formId");
CREATE INDEX IF NOT EXISTS form_files_submission_idx ON form_files ("submissionId");
-- The purge's two predicates read only rows not yet purged.
CREATE INDEX IF NOT EXISTS form_files_live_idx ON form_files ("createdAt") WHERE "purgedAt" IS NULL;
