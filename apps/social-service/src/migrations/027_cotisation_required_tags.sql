BEGIN;
ALTER TABLE association_products ADD COLUMN IF NOT EXISTS "requiredTags" TEXT[];
COMMIT;
