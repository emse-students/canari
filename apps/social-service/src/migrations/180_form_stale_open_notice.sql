-- Migration 180: the one question asked of an open form nobody answers any more (owner, 2026-11-21).
--
-- docs/wiki/frontend/modules/forms.md, "The question put to a form left open". 17 of 21 forms on
-- production had no closing date and 9 of them had been silent for 14 days or more: nothing ever
-- told their managers. A daily sweep now asks the owner and the MANAGE_FORMS holders ONCE
-- ("Ce formulaire est toujours ouvert. Le fermer ?"), and these two columns are its whole memory:
--
-- 1. `forms."staleAskedAt"`: timestamptz NULL - when the question was last asked. The sweep claims a
--    form by writing it (one conditional statement), so a second replica, a re-run or a crash asks
--    nothing twice. The question is re-armed ONLY by an answer that arrived after it - never by a
--    timer.
-- 2. `forms."staleKeptAt"`: timestamptz NULL - when a manager pressed "Garder ouvert". It only
--    hides the question from the list and clears the bell row; the sweep does not read it.
--
-- NULL on every existing form (no backfill): the first sweep after the deploy asks the forms that
-- qualify then.
--
-- ADDITIVE and plain (not held): two nullable columns without default, no constraint, no rewrite.
-- Idempotent for CD (IF NOT EXISTS). An older container never names them. Reversible:
-- `ALTER TABLE forms DROP COLUMN "staleAskedAt"` and `... "staleKeptAt"` lose only the memory.
-- LOCKS: ACCESS EXCLUSIVE on `forms` for the catalogue change alone (no scan), released at COMMIT;
-- the migration gives up after 5 s rather than queue behind a long transaction.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE forms ADD COLUMN IF NOT EXISTS "staleAskedAt" timestamptz NULL;
ALTER TABLE forms ADD COLUMN IF NOT EXISTS "staleKeptAt" timestamptz NULL;

COMMIT;
