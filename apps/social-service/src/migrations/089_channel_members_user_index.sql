-- Migration 089: an index on channel_members ("userId"), and nothing else (WP-PRESENCE, 2026-10-18).
--
-- `POST /internal/presence/shared-communities` starts every presence poll (every 10 s per open
-- client) with "which communities is the viewer in": `WHERE "userId" = $1`. The table's only
-- index is the unique ("workspaceId", "userId"), which cannot serve a predicate on its SECOND
-- column, so that lookup was a sequential scan of every membership row.
--
-- Additive: no column, no data rewrite. Idempotent: IF NOT EXISTS. Not CONCURRENTLY, as migration
-- 079: the table is one row per person per community, and building the index holds a SHARE lock
-- (writes wait, reads do not) for the length of one pass over it. 089 and not 086/088: 086 is held
-- by an open pull request, and a duplicate number orders by the rest of the filename.

BEGIN;

CREATE INDEX IF NOT EXISTS "IDX_channel_members_user"
  ON channel_members ("userId");

COMMIT;
