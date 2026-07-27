-- Migration 030: rewrites the legacy permission keys in channel_roles to the unified ones
-- (MANAGE_WORKSPACE -> workspace.manage, and so on).
-- `permissions` is a TypeORM simple-array, stored as comma-separated text.
-- Each REPLACE only touches the exact legacy substring; already-migrated keys
-- (workspace.manage, ...) do not contain these patterns and are left alone.
-- Idempotent: REPLACE is a no-op when the key is absent.

BEGIN;

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'MANAGE_WORKSPACE', 'workspace.manage');

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'MANAGE_CHANNELS', 'channel.manage');

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'MANAGE_ROLES', 'role.manage');

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'SEND_MESSAGES', 'channel.send');

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'MODERATE_MESSAGES', 'channel.moderate');

UPDATE channel_roles
SET permissions = REPLACE(permissions, 'INVITE_USERS', 'member.invite');

COMMIT;
