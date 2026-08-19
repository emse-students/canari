-- Migration 037: independent Lydia Connect columns, so Stripe and Lydia onboarding coexist.
-- Until now both providers wrote through the same `stripeAccountId`/`stripeOnboardingComplete`
-- pair (the name is a historical artifact from when Stripe was the only provider) - flipping the
-- admin-configured active provider never changed stored data, but the two providers shared the
-- same two columns, so an association that had onboarded with one and then tried the other would
-- overwrite the first one's account id and completion flag. Each provider now owns its own pair.
-- All columns are nullable/defaulted so existing rows are unaffected. Idempotent via IF NOT EXISTS.

BEGIN;

ALTER TABLE associations ADD COLUMN IF NOT EXISTS "lydiaAccountId" VARCHAR;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "lydiaOnboardingComplete" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
