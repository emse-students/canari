-- Migration 047: the notification categories whose PUSH is off until the account turns it on
-- ("Nos principes", owner 2026-11-10, and the owner's "Deux niveaux" of 2026-11-11: the in-app
-- suggestions stay on by default, their PUSH is opt-in; each is switched off in one gesture).
--
-- `notification_preference."disabledCategories"` (migration 028) stores what an account switched
-- OFF, so a category nobody touched is ON. That reading cannot say "off until asked". This column
-- stores the OPT-IN categories (`OPT_IN_CATEGORIES` in services/push-category.ts, today only
-- `suggestions`) whose push the account switched ON: an opt-in category is pushed only when listed
-- here AND not listed in `disabledCategories` (which, for `suggestions`, is the in-app switch).
--
-- NO BACKFILL, on purpose: no account can be told apart as having CHOSEN the push - the switch shipped
-- in 1.6.10-alpha.1 only, and its absence from `disabledCategories` is also what every save made by a
-- build that never drew it (or that saved another switch) wrote. Every account therefore starts with
-- the push of the opt-in categories off; one that switched the alpha.1 switch off keeps both off.
-- social-service reads the same two columns (`push/notification-category.ts`), in the same database.
--
-- ADDITIVE ONLY: a new column with a constant default, a catalogue-only change on PostgreSQL 11+
-- (no table rewrite). A release that predates it does not read it, so a rollback is safe.
-- Idempotent for CD: IF NOT EXISTS. The table is read before every push, so the ALTER gives up
-- after five seconds rather than queue behind a long transaction; a re-run is safe.

SET lock_timeout = '5s';

ALTER TABLE notification_preference
  ADD COLUMN IF NOT EXISTS "enabledCategories" JSONB NOT NULL DEFAULT '[]'::jsonb;
