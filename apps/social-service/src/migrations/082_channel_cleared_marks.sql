-- Migration 082: how far each member has CLEARED each salon's unread count without reading it.
--
-- See docs/wiki/frontend/modules/chat.md ("Mark a whole community as read").
--
-- "Marquer tout comme lu" on a community icon empties every salon's badge at once. The badge is
-- counted by the server against the member's read mark (`readMarks`, migration 066), but that mark is
-- ALSO the "Lu par" receipt the other members see - so raising it from a menu would tell a sender
-- their message was read by someone who never opened the salon. This is the private half: one
-- instant per salon, keyed by channel id like `readMarks` beside it, that `listUnreadCounts` adds to
-- the floor of what it counts and that nothing ever sends to anybody else.
--
-- The value is a message's server `createdAt` in epoch milliseconds, bounded by the salon's newest
-- message, and only ever raised (see `clearWorkspaceUnread`). On the membership row, so it goes when
-- the membership goes, with nothing else to purge.
--
-- DECLARED ON THE TYPEORM ENTITY WITH `select`/`insert`/`update: false`: the deploy starts the
-- containers BEFORE it applies migrations (docs/wiki/services/social-service.md, "A query at boot runs
-- BEFORE the migration that adds its column"), so a plain entity column would put it in every `SELECT`
-- of `channel_members` during that window - but leaving it OFF the entity let `synchronize` (on outside
-- production) DROP it at every local boot. Read and written by raw SQL only; the window costs the two
-- queries that name it and the RETURNING of a new membership's INSERT, never a membership read.
--
-- Idempotent via IF NOT EXISTS.

BEGIN;

ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS "clearedMarks" JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
