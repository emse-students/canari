-- canari:hold-for-owner - a DROP COLUMN: `users."stripeCustomerId"`, the last Stripe column here.
--
-- Migration 027: the per-user Stripe customer id goes (owner, 2026-11-19: "Tu peux tout supprimer
-- en ce qui concerne Stripe"; docs/wiki/stripe-archive.md, "the names that outlived the processor").
-- Its twin, social-service 177, drops the association pair and rewrites the retired `stripe` value.
--
-- WHY IT IS DEAD. It held the customer the saved-card flow charged. That flow, and the mapping of
-- the column, went with Stripe in #1589 (2026-10-08, first shipped in `v1.2.0-alpha.1` and the stable
-- `v1.2.0`); nothing has read or written it since, and the local copy already blanks it. 011 left it
-- in place only so the previous release could still be rolled back to; that window closed long ago.
--
-- COUNT BEFORE (read-only, on the estate about to run it):
--   SELECT count(*) FROM users WHERE "stripeCustomerId" IS NOT NULL;
--
-- ROLLBACK. The deploy takes a backup right before a held migration; the ids come back only from it,
-- and nothing can use them (no Stripe key exists anywhere). The shape comes back with
--   ALTER TABLE users ADD COLUMN IF NOT EXISTS "stripeCustomerId" varchar NULL;
-- No image needs it: every image since `v1.2.0` ignores the column. A rollback to an image OLDER
-- than `v1.2.0` fails every user INSERT once this has run - the rollback floor it sets.
--
-- LOCKS. ACCESS EXCLUSIVE on `users` for a catalogue change alone (a dropped column is only marked
-- dropped - no scan, no rewrite), released at COMMIT. `users` is read on every authenticated
-- request, so a request holding a lock makes the migration give up after 5 s rather than queue every
-- login behind it; the re-run is safe.
--
-- IDEMPOTENT: `DROP COLUMN IF EXISTS`, so a replay, or a local stack whose `synchronize` never had
-- the column, does nothing. No CASCADE: no index, view or constraint names it, and one that did
-- should stop this file loudly rather than go with it.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS "stripeCustomerId";

COMMIT;
