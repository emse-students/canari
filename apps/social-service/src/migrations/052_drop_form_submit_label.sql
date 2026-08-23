-- Migration 052: a form's submit label was a French sentence stored in the database.
--
-- `submitLabel` looked like a manager's setting and never was one: no screen has ever offered a
-- field for it, and both admin pages wrote a hard-coded literal - 'Envoyer et payer' when the form
-- takes money, 'Envoyer' otherwise - which the fill page then rendered raw, with `|| 'Envoyer'`
-- behind it for the rows the entity default had left as 'Submit'. So a column existed whose only
-- values were two French strings computed from another column, displayed to an English user in
-- French, and invisible to Paraglide because nothing types a stored string as user-visible.
--
-- The label is derived from `requiresPayment` at render time now, from the message catalogue like
-- every other word on that page. Nothing is migrated because nothing was ever authored: every row
-- holds one of three literals this code wrote itself.
--
-- If a per-form label is ever actually wanted, it comes back as a message KEY or as a translated
-- map - never as one language's sentence in a column.
BEGIN;

ALTER TABLE forms DROP COLUMN IF EXISTS "submitLabel";

COMMIT;
