-- Migration 178: an anonymous form's answers are stored in batches.
--
-- docs/wiki/frontend/modules/forms.md, "An anonymous form's answers are released in batches". An
-- answer to an anonymous form waits in `form_answers_held` and moves into `submissions` with others
-- of its form, in one write, once ANONYMOUS_BATCH_SIZE answers wait, or all of them once the form
-- stops taking answers (`anonymous-answer-batches.ts`). What is stored must not pair an account with
-- an answer, including the columns the database keeps about each write.
--
-- 1. `form_answers_held`: the answer's own columns and nothing that names or dates it - no account,
--    no address, no timestamp. Its id is random. `formId` references the form WITHOUT a cascade, as
--    `submissions` does: a form whose answers wait is archived, never removed (`retireForms`).
-- 2. The table's autovacuum runs as soon as a row is gone: a released row's old version is cleared
--    at the next autovacuum pass rather than left until the table grows.
--
-- Additive (a new table, no change to a stored row) and idempotent. Nothing is backfilled: every
-- answer stored before this file stays where it is.
--
-- ROLLBACK. An image older than this file never reads the table; answers waiting in it are moved to
-- `submissions` by releasing them first (close the form, or run the release of the new image). The
-- shape goes with `DROP TABLE form_answers_held` once it is empty.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS form_answers_held (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "formId" uuid NOT NULL REFERENCES forms (id),
  answers jsonb NOT NULL DEFAULT '{}',
  lines jsonb NULL,
  "priceLockedItemIds" jsonb NULL,
  "respondentIdentity" jsonb NULL
);

CREATE INDEX IF NOT EXISTS form_answers_held_form_idx ON form_answers_held ("formId");

ALTER TABLE form_answers_held
  SET (autovacuum_vacuum_threshold = 0, autovacuum_vacuum_scale_factor = 0);
