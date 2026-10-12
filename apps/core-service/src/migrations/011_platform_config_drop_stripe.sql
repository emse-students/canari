-- Stripe left the product (docs/wiki/stripe-archive.md): 'stripe' is no longer a value the
-- `payment_provider` column may hold, and the default for a fresh row is the fail-closed one.
--
-- A row still on 'stripe' is moved to 'disabled', NOT 'lydia': nothing here can know that Lydia is
-- configured for that estate, and 'disabled' refuses every checkout with one clear 400 instead of
-- sending buyers into a provider with no credentials. An admin switches it back at /admin/platform.
--
-- The users."stripeCustomerId" column and the social-service stripe_* columns are NOT dropped by
-- this migration: dropping a column the PREVIOUS release still maps would crash that release on a
-- rollback. They are dropped in a later migration, once this release is the floor.
--
-- Idempotent: the migration runner re-runs a file whose deploy died part-way through.
UPDATE platform_config SET payment_provider = 'disabled' WHERE payment_provider = 'stripe';
ALTER TABLE platform_config ALTER COLUMN payment_provider SET DEFAULT 'disabled';
