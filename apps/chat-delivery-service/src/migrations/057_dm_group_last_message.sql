-- Migration 057: the server's receive time of each conversation's newest visible frame (2026-11-24;
-- docs/wiki/frontend/modules/chat.md, "The server's newest visible frame is a floor under the key").
--
-- `dm_group_last_message`: one row per group, written by every send of a visible frame (a message
-- or a group event the members see - not silent, durable, not addressed, never a Welcome or a
-- Commit), moved forward only (an upsert with GREATEST). It is the receive instant every recipient's
-- copy already carries: no content, no author. `GET /mls/users/:id/groups` returns it to the
-- group's admitted members, so a device with no history yet orders its conversation list from it.
--
-- A TABLE OF ITS OWN, NOT A COLUMN OF `dm_groups`. An UPDATE of the group row takes FOR NO KEY
-- UPDATE on it, which conflicts with the FOR SHARE every send into the group takes on the same row
-- (`enqueueForLiveGroup`), so the sends of one group would queue behind each other's note. The
-- insert reads the group row FOR SHARE, live groups only (`NOTE_LAST_MESSAGE_SQL`), which conflicts
-- with no send, and waits for a deletion holding the row, then inserts nothing. And it goes WITH
-- THE CONVERSATION: ON DELETE CASCADE for a hard delete, and
-- `GROUP_OWNED_TABLES` for the soft delete that keeps the tombstone. The hourly retention sweep
-- deletes a row older than the queued copies it stands for (`MESSAGE_RETENTION_MS`, 90 days).
--
-- ADDITIVE ONLY: a new table, no backfill (none is possible - the history stream does not record
-- which frames were silent). A group with no row orders as before, by its last update. A release
-- that predates it reads nothing of it, so a rollback is safe.
--
-- LOCK TIMEOUT: the foreign key takes SHARE ROW EXCLUSIVE on `dm_groups`, which every commit
-- writes. The migration gives up after five seconds rather than queue behind a long transaction; a
-- re-run is safe (idempotent).
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "dm_group_last_message" (
  "groupId" uuid PRIMARY KEY REFERENCES "dm_groups"("id") ON DELETE CASCADE,
  "lastMessageAt" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "IDX_dm_group_last_message_at" ON "dm_group_last_message" ("lastMessageAt");
