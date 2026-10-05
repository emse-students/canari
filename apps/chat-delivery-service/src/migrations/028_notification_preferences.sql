-- Migration 028: per-account notification categories the user has switched off.
--
-- One row per account that ever changed the setting; an account with no row has everything ON.
-- The set stored is the DISABLED one, so a category added later is on for everybody with no backfill.
-- Read by MessagingService before every visible push (see services/push-category.ts).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS (synchronize creates it in dev; this is for prod).

CREATE TABLE IF NOT EXISTS notification_preference (
    "userId"              VARCHAR(255) PRIMARY KEY,
    "disabledCategories"  JSONB NOT NULL DEFAULT '[]'::jsonb,
    "updatedAt"           TIMESTAMP NOT NULL DEFAULT now()
);
