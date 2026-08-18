-- Migration 037: a community remembers its Graine key-distribution group.
--
-- The group itself is a `dm_groups` row owned by chat-delivery (migration 014 there), keyed by
-- "distributionWorkspaceId". This column is the reverse pointer, and it is NOT a second source of
-- truth: it holds an IMMUTABLE identifier minted once, when the community is created, by the very
-- call that created the group. An identifier that never changes cannot drift from the row it names,
-- which is exactly why duplicating it is safe here and would not be for membership.
--
-- Nullable, and it stays nullable: a community created before Graine has none, and that must read
-- as "none" rather than as a broken row. Every consumer treats null as "not initialised yet".
--
-- Column is double-quoted camelCase to match TypeORM's default naming (see migration 029).
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when the column already exists.

BEGIN;

ALTER TABLE channel_workspaces
  ADD COLUMN IF NOT EXISTS "distributionGroupId" UUID;

COMMIT;
