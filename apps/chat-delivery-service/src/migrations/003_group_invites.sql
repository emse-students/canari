-- Migration 003: shareable invite links for MLS group chats.
-- Accepting an invite only inserts GroupMember + pending DeviceGroupMembership rows;
-- the existing pending-invitation pipeline performs the actual MLS Add + Welcome.
-- Quoted camelCase columns to match TypeORM's default naming. Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS group_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "groupId" UUID NOT NULL,
  "token" VARCHAR NOT NULL,
  "createdBy" VARCHAR(255) NOT NULL,
  "expiresAt" TIMESTAMPTZ NULL,
  "maxUses" INTEGER NULL,
  "uses" INTEGER NOT NULL DEFAULT 0,
  "revoked" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_invites_token ON group_invites ("token");
CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites ("groupId");

COMMIT;
