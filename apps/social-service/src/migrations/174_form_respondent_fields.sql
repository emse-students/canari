-- Migration 174 : a form chooses which of the respondent's account fields travel with each answer
-- (owner, 2026-11-16).
--
-- docs/wiki/frontend/modules/forms.md, "The respondent's account fields". An organiser ticks, per
-- form, any of "Nom", "Prenom", "Promo et formation", "Statut eleve / personnel", "Campus". For a
-- member of a named form they are read from the account AT SUBMIT TIME and stored with the answer (a
-- snapshot); whoever the form cannot read from an account (a guest, an anonymous form) is asked them
-- instead, through the existing `forms."guestFields"` list (migration 138), whose jsonb now also
-- holds `cursus`, `status`, `campus` - no schema change for that half.
--
-- 1. `forms."respondentFields"`: jsonb NOT NULL DEFAULT '["lastName","firstName"]' - what a form
--    joins from a member's account. The default is exactly what every named form did before this
--    file (the responses list and the export named each member), so no existing form changes. An
--    anonymous form's row reads the default too and joins nothing: its answers name no account, and
--    the service reads the list as empty there (`joinedAccountFields`); a save stores [] for it.
-- 2. `submissions."respondentIdentity"`: jsonb NULL - the snapshot (`source`, and only the fields
--    the form joined or asked). NULL on every existing answer: those keep reading the account's name
--    live, as they always did - the read path tells them apart by this NULL alone.
--
-- No backfill (no UPDATE): the default and the NULL above say what the data already meant.
--
-- ADDITIVE and plain (not held): two new columns, a constant default (a catalogue change since
-- PostgreSQL 11, no rewrite of `forms`), no constraint. Idempotent for CD (IF NOT EXISTS).
-- Reversible: `ALTER TABLE forms DROP COLUMN "respondentFields"` and
-- `ALTER TABLE submissions DROP COLUMN "respondentIdentity"` undo it, losing the settings and the
-- snapshots taken since; the declared asks left in `guestFields` are ignored by an older image
-- (`askedGuestFields` drops a name it does not know, with a warning).
-- A side effect, stated: the unpublished revision fingerprint (`FORM_FINGERPRINT_SQL`) covers every
-- column of `forms`, so a revision OPEN when this file runs is told once that the form changed
-- since it ("Publier quand meme"), as with migration 166.
-- LOCKS: ACCESS EXCLUSIVE on each table for the catalogue change alone (no scan), released at
-- COMMIT; the migration gives up after 5 s rather than queue behind a long transaction.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE forms
  ADD COLUMN IF NOT EXISTS "respondentFields" jsonb NOT NULL DEFAULT '["lastName","firstName"]'::jsonb;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "respondentIdentity" jsonb NULL;

COMMIT;
