-- Migration 057: the server's receive time of each conversation's newest visible frame (2026-11-24;
-- docs/wiki/frontend/modules/chat.md, "The conversation list has one ordering key").
--
-- `dm_groups."lastMessageAt"`: written by every send of a visible frame (a message or a group event
-- the members see - not silent, durable, not addressed, never a Welcome or a Commit), moved forward
-- only. It is the receive instant every recipient's copy already carries: no content, no author.
-- `GET /mls/users/:id/groups` returns it, so a device with no history yet orders its conversation
-- list from it. The hourly retention sweep sets it back to NULL once it is older than the queued
-- copies it stands for (`MESSAGE_RETENTION_MS`), so it is never kept longer than those copies.
--
-- ADDITIVE ONLY: one nullable column, no default, no backfill (an empty column orders as before,
-- by the group's last update). A release that predates it reads nothing of it, so a rollback is safe.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `dm_groups`, which every commit reads. The
-- migration gives up after five seconds rather than queue behind a long transaction; a re-run is
-- safe (idempotent).
SET lock_timeout = '5s';

ALTER TABLE "dm_groups" ADD COLUMN IF NOT EXISTS "lastMessageAt" timestamptz;
