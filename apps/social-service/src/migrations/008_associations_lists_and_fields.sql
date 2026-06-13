-- Migration 008: lists (type discriminator) + archival + contact email on associations.
-- The `associations` table is created by TypeORM synchronize with the default naming
-- strategy (quoted camelCase columns), so new columns are quoted to match (see migration 003).
-- All statements use IF NOT EXISTS so this script is idempotent.

BEGIN;

-- Soft-archival: archived associations move to the "Anciennes" section and are hidden
-- from "Mes associations".
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "archived" BOOLEAN NOT NULL DEFAULT false;

-- Public contact e-mail shown under the name on the trombinoscope and on the association page.
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "contactEmail" VARCHAR(255);

-- Type discriminator: 'association' (default) or 'list' (promo lists).
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "type" VARCHAR(20) NOT NULL DEFAULT 'association';

-- Lists only: the promotion year the list belongs to (e.g. 2027). NULL for associations.
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "promo" INTEGER;

-- Lists only: optional parent association (e.g. the BDE that owns the list). NULL otherwise.
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "parentAssociationId" UUID;

CREATE INDEX IF NOT EXISTS idx_associations_type ON associations ("type");

COMMIT;
