-- canari:hold-for-owner - a DROP of two columns and a rewrite of a retired value: the Stripe leftovers.
--
-- Migration 177: what Stripe left in this service's tables goes (owner, 2026-11-19: "Tu peux tout
-- supprimer en ce qui concerne Stripe"; docs/wiki/stripe-archive.md, "the names that outlived the
-- processor"). Its twin, core-service 027, drops `users."stripeCustomerId"`.
--
-- WHAT IT DROPS, AND WHY IT IS DEAD.
--   - `associations."stripeAccountId"` and `"stripeOnboardingComplete"`: the Stripe Connect pair.
--     UNMAPPED from the entity by #1669 (2026-10-11, first shipped in `v1.2.4-alpha.1` and the
--     stable `v1.2.4`); nothing has read or written them since, and both estates serve far later
--     images, so no running image names them in an INSERT.
--   - `paymentMethod = 'stripe'` on `purchase_records` (-> `online`, the value the code already read
--     it as) and on `submissions` (-> NULL, the value an online answer carries; `cash` is the only
--     other). Nothing has written `stripe` since 2026-10-08 (#1589) and nothing may send it since
--     floor 1.2.7; this retires the shim of docs/wiki/legacy-compatibility.md. What is lost is the
--     label "Stripe" on those rows: the processor stays readable from their own reference (a `pi_...`
--     in `purchase_records."stripePaymentIntentId"`, a `cs_...` in `submissions."stripeSessionId"`),
--     which this file does not touch - those two columns hold the LIVE Lydia references.
--
-- COUNT BEFORE (read-only, on the estate about to run it; all four are expected small, and a
-- `stripeAccountId` count above zero is the historic Connect ids, measured 5 on 2026-09-01):
--   SELECT count(*) FILTER (WHERE "stripeAccountId" IS NOT NULL) AS stripe_ids,
--          count(*) FILTER (WHERE "stripeOnboardingComplete") AS stripe_onboarded FROM associations;
--   SELECT count(*) FROM purchase_records WHERE "paymentMethod" = 'stripe';
--   SELECT count(*) FROM submissions WHERE "paymentMethod" = 'stripe';
--
-- ROLLBACK. The deploy takes a backup right before a held migration; the values come back only from
-- it. The shape comes back with
--   ALTER TABLE associations ADD COLUMN IF NOT EXISTS "stripeAccountId" varchar NULL,
--     ADD COLUMN IF NOT EXISTS "stripeOnboardingComplete" boolean NOT NULL DEFAULT false;
-- and the rewritten rows with `UPDATE purchase_records SET "paymentMethod" = 'stripe' WHERE
-- "paymentMethod" = 'online' AND "stripePaymentIntentId" ~ '^pi_'` (a Lydia reference is a
-- number). No image needs either: every image since `v1.2.4` ignores the columns, and every client
-- reads `online` and NULL already. A rollback to an image OLDER than `v1.2.4` fails every association
-- INSERT once this has run - that is the rollback floor it sets, years below the one in force.
--
-- LOCKS. The two UPDATEs take row locks on the few rows they match; the ALTER takes ACCESS EXCLUSIVE
-- on `associations` for a catalogue change alone (a dropped column is only marked dropped - no scan,
-- no rewrite), placed LAST so it is held for the shortest time, released at COMMIT. A request
-- holding a lock makes the migration give up after 5 s rather than queue every association read
-- behind it; the re-run is safe.
--
-- IDEMPOTENT: the UPDATEs match nothing the second time, and `DROP COLUMN IF EXISTS` does nothing on
-- a replay or on a local stack whose `synchronize` never had the columns. No CASCADE: no index, view
-- or constraint names them, and one that did should stop this file loudly rather than go with it.

SET lock_timeout = '5s';

BEGIN;

UPDATE purchase_records SET "paymentMethod" = 'online' WHERE "paymentMethod" = 'stripe';
UPDATE submissions SET "paymentMethod" = NULL WHERE "paymentMethod" = 'stripe';

ALTER TABLE associations
  DROP COLUMN IF EXISTS "stripeAccountId",
  DROP COLUMN IF EXISTS "stripeOnboardingComplete";

COMMIT;
