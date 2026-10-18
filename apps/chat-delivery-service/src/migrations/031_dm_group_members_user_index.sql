-- Migration 031: an index on dm_group_members ("userId"), and nothing else (WP-PRESENCE, 2026-10-18).
--
-- `POST /internal/presence/shared-conversations` starts every presence poll (every 10 s per open
-- client) with "which conversations is the viewer in": `WHERE "userId" = $1`. The table's only
-- index is the unique ("groupId", "userId"), which cannot serve a predicate on its SECOND column,
-- so that lookup was a sequential scan of every membership row. `getUserGroups` runs the same
-- predicate and paid the same scan.
--
-- Additive: no column, no data rewrite. Idempotent: IF NOT EXISTS. Not CONCURRENTLY, as migration
-- 079 of social-service: the table is one row per person per conversation, and building the index
-- holds a SHARE lock (writes wait, reads do not) for the length of one pass over it.

BEGIN;

CREATE INDEX IF NOT EXISTS "IDX_dm_group_members_user"
  ON dm_group_members ("userId");

COMMIT;
