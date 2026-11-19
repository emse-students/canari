-- canari:hold-for-owner - a DROP of two columns: the Stripe Connect pair on `associations`.
--
-- Migration 177: the dead Stripe columns of this service go (owner, 2026-11-19: "Tu peux tout
-- supprimer en ce qui concerne Stripe"; docs/wiki/stripe-archive.md, "the last removal"). Its twin,
-- core-service 027, drops `users."stripeCustomerId"`.
--
-- WHAT IT DROPS, AND WHY IT IS DEAD. `associations."stripeAccountId"` and
-- `"stripeOnboardingComplete"`, the Stripe Connect pair. UNMAPPED from the entity by #1669
-- (2026-10-11, first shipped in `v1.2.4-alpha.1` and the stable `v1.2.4`); nothing has read or
-- written them since, and both estates serve far later images, so no running image names them in
-- an INSERT.
--
-- WHAT IT DELIBERATELY LEAVES. The stored `paymentMethod = 'stripe'` on `purchase_records` and
-- `submissions` is NOT rewritten: it is historic data that live readers tell apart from `online`
-- and from NULL (the refund target answers `not-online` for it, the Lydia contract flux counts only
-- `online`, the responses table shows a paid NULL without a method), and on a form-source purchase
-- it is the only marker of the processor. `submissions."stripeSessionId"` and
-- `purchase_records."stripePaymentIntentId"` hold the LIVE Lydia references and are not touched.
--
-- COUNT BEFORE (read-only, on the estate about to run it; a non-zero `stripe_ids` is the historic
-- Connect ids, measured 5 on 2026-09-01):
--   SELECT count(*) FILTER (WHERE "stripeAccountId" IS NOT NULL) AS stripe_ids,
--          count(*) FILTER (WHERE "stripeOnboardingComplete") AS stripe_onboarded FROM associations;
--
-- ROLLBACK. The deploy takes a backup right before a held migration; the values come back only from
-- it, and nothing can use them (no Stripe key exists anywhere). The shape comes back with
--   ALTER TABLE associations ADD COLUMN IF NOT EXISTS "stripeAccountId" varchar NULL,
--     ADD COLUMN IF NOT EXISTS "stripeOnboardingComplete" boolean NOT NULL DEFAULT false;
-- No image needs it: every image since `v1.2.4` ignores the columns. A rollback to an image OLDER
-- than `v1.2.4` fails every association INSERT once this has run - the rollback floor it sets, far
-- below the one in force.
--
-- LOCKS. ACCESS EXCLUSIVE on `associations` for a catalogue change alone (a dropped column is only
-- marked dropped - no scan, no rewrite), released at COMMIT. A request holding a lock makes the
-- migration give up after 5 s rather than queue every association read behind it; the re-run is
-- safe.
--
-- IDEMPOTENT: `DROP COLUMN IF EXISTS` does nothing on a replay or on a local stack whose
-- `synchronize` never had the columns. No CASCADE: no index, view or constraint names them, and one
-- that did should stop this file loudly rather than go with it.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE associations
  DROP COLUMN IF EXISTS "stripeAccountId",
  DROP COLUMN IF EXISTS "stripeOnboardingComplete";

COMMIT;
