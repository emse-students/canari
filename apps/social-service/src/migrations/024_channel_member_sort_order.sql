-- Migration 024 : per-user display order for communities (workspaces) in the sidebar.
-- The order is personal (each member can reorder their own view), so it lives on
-- channel_members rather than channel_workspaces. Idempotent for CD.

ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS "sortOrder" int NOT NULL DEFAULT 0;
