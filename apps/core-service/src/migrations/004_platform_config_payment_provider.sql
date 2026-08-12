-- WP-LYDIA-1 added `paymentProvider` to the PlatformConfig entity without a migration.
--
-- `synchronize` is false in production (app.module.ts), so an entity column with no migration does
-- not appear - and `PlatformService.ensureDefaults` runs in `onModuleInit`, so the SELECT naming the
-- missing column threw before the module finished booting. core-service crash-looped from the
-- moment that image shipped, taking auth, users and payments down with it, and the deploy's own
-- secret-drift check then failed too because it cannot read the environment of a restarting
-- container - which is why the three following deploys reported `JWT_SECRET is not correctly
-- applied` while nothing was wrong with JWT_SECRET.
--
-- The default matches the entity's, so the singleton row keeps routing to Stripe until an admin
-- switches it at /admin/platform. Idempotent: the migration runner re-runs a file whose deploy died
-- part-way through.
ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS payment_provider VARCHAR(16) NOT NULL DEFAULT 'stripe';
