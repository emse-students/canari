-- Migration 010: shareable community (workspace) invite links.
-- Quoted camelCase columns to match TypeORM's default naming on the channels tables
-- (see migration 003). Idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS workspace_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "token" VARCHAR NOT NULL,
  "createdBy" VARCHAR(255) NOT NULL,
  "expiresAt" TIMESTAMPTZ NULL,
  "maxUses" INTEGER NULL,
  "uses" INTEGER NOT NULL DEFAULT 0,
  "revoked" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invites_token ON workspace_invites ("token");
CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace ON workspace_invites ("workspaceId");

COMMIT;
