-- Migration 032: removes the per-channel/per-role permission-override system.
-- The community access model is simplified to: public = all members, private = explicit
-- allowedUsers (+ admins always), plus a per-channel writePolicy (migration 031).
-- Drops the overrides table and the channels."usePermissionOverrides" toggle (migrations 028/029).
-- Idempotent: IF EXISTS guards make re-runs safe.

BEGIN;

DROP TABLE IF EXISTS channel_permission_overrides;

ALTER TABLE channels DROP COLUMN IF EXISTS "usePermissionOverrides";

COMMIT;
