-- Migration 164 : a respondent may change their own answer, when the form allows it (owner, 2026-11-13).
--
-- docs/wiki/frontend/modules/forms.md, "A respondent changes their own answer". A new per-form
-- setting, "Autoriser la modification de la reponse", OFF by default: when on, a respondent with an
-- account reopens their own answer while the form is open and changes it, the questions that touch
-- the price excepted (`answer-edit.ts`). The managers see when an answer was last changed.
--
-- 1. `forms."allowAnswerEdit"`: boolean NOT NULL DEFAULT false. Every existing form keeps today's
--    behaviour (an answer is final). A constant default is a catalogue change since PostgreSQL 11:
--    no rewrite of `forms`.
-- 2. `submissions."editedAt"`: timestamptz NULL - the instant the respondent last changed the answer,
--    NULL on every answer never changed (every existing row). NOT `updatedAt`: that column moves on
--    every payment status change (`markPaid`, a cash validation, the expiry job), so it cannot say
--    whether the RESPONDENT changed anything.
--
-- ADDITIVE and plain (not held): two new columns, no backfill, no constraint. Idempotent for CD
-- (IF NOT EXISTS). Reversible: `ALTER TABLE forms DROP COLUMN "allowAnswerEdit"` and
-- `ALTER TABLE submissions DROP COLUMN "editedAt"` undo it, losing only the setting and the dates.
-- LOCKS: ACCESS EXCLUSIVE on each table for the catalogue change alone (no scan), released at
-- COMMIT; the migration gives up after 5 s rather than queue behind a long transaction.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE forms ADD COLUMN IF NOT EXISTS "allowAnswerEdit" boolean NOT NULL DEFAULT false;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "editedAt" timestamptz NULL;

COMMIT;
