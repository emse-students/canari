-- Migration 001 : permission enum → permissions bitmask
-- Run this BEFORE deploying the new code so admin data is preserved.
-- With synchronize=true, TypeORM will then only add the new columns for associations.
--
-- ALL_CORE_FLAGS = 1|2|4|8|16|256 = 287
-- (POST_AS_ASSO | PROPOSE_EVENT | MANAGE_MEMBERS | MANAGE_DOCUMENTS | MANAGE_FORMS | MANAGE_PRODUCTS)

BEGIN;

-- 1. Add the new integer column alongside the old enum column.
ALTER TABLE association_members ADD COLUMN IF NOT EXISTS permissions INTEGER NOT NULL DEFAULT 0;

-- 2. Migrate ex-admins (old permission = '1' = Admin) to ALL_CORE_FLAGS = 287.
UPDATE association_members SET permissions = 287 WHERE permission::text = '1';

-- 3. Drop the old enum column (TypeORM synchronize would do this anyway, but we do it here
--    explicitly so the data is already migrated when synchronize runs).
ALTER TABLE association_members DROP COLUMN IF EXISTS permission;
DROP TYPE IF EXISTS association_permission_enum;

-- 4. New columns on associations (TypeORM synchronize will also add these,
--    but listing them here for completeness and manual runs).
ALTER TABLE associations ADD COLUMN IF NOT EXISTS is_bde BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS document_vault_key VARCHAR(64);
ALTER TABLE associations ADD COLUMN IF NOT EXISTS document_quota_bytes BIGINT NOT NULL DEFAULT 524288000;

COMMIT;
