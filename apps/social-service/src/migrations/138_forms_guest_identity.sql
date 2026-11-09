-- Migration 138 : a public form may ask its guests for a name and an e-mail (owner, 2026-11-06).
--
-- docs/wiki/frontend/modules/forms.md, "A guest's name and e-mail, when the form asks". A guest
-- answering a PUBLIC form at /f/:id has no account, and by default is asked nothing about who they
-- are. The form's creator may now ask for a last name, a first name and an e-mail - three independent
-- choices, all off by default - so an organiser can find who ordered. Members never see them.
--
-- 1. `forms."guestFields"`: jsonb NULL - the fields asked of a guest, a list drawn from
--    `lastName`, `firstName`, `email`. NULL (every existing form) asks nothing, which is today.
-- 2. `submissions."guestLastName"`, `"guestFirstName"`: varchar(100) NULL - what a guest typed,
--    only when the form asked for it. NULL on every member's answer and every existing row.
-- 3. `submissions."guestEmail"`: varchar(254) NULL - same rule. When the form asks for it, it is
--    also the address Lydia's payment request goes to (the guest types one address, never two).
--
-- No backfill: no answer before this file was asked for any of them.
--
-- ADDITIVE: four nullable columns, no default, no constraint - catalogue changes, no rewrite of
-- `forms` or `submissions`. Idempotent for CD: IF NOT EXISTS.
-- LOCKS: ACCESS EXCLUSIVE on each table for the catalogue change alone (no scan), released at
-- COMMIT; the migration gives up after 5 s rather than queue behind a long transaction.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE forms ADD COLUMN IF NOT EXISTS "guestFields" jsonb NULL;

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "guestLastName" varchar(100) NULL;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "guestFirstName" varchar(100) NULL;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "guestEmail" varchar(254) NULL;

COMMIT;
