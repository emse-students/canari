-- Migration 111: channels."accessRevision", the revision an access rewrite names as its base.
--
-- See apps/social-service/src/channels/entities/channel.entity.ts and
-- docs/wiki/services/social-service.md ("An access rewrite names the revision it edited").
--
-- The salon settings panel rewrites the whole allowlist it read when it opened. Every write of a
-- salon's visibility, allowlist or write policy now raises this number, and a rewrite naming a
-- revision that is no longer current is refused with 409 CHANNEL_ACCESS_CHANGED instead of dropping
-- whoever was granted meanwhile.
--
-- Schema only: one column, NOT NULL DEFAULT 0, which PostgreSQL adds without rewriting the table.
-- Every existing salon starts at revision 0; nothing is backfilled, nothing is dropped.
--
-- ROLLBACK: an image older than this migration writes no revision, so after rolling back and
-- forward a settings panel opened before the rollback can save over a write the old image made.
--
-- Idempotent for CD: IF NOT EXISTS.
--
-- LOCK TIMEOUT: `channels` is read by every salon listing; if a long transaction holds it, this
-- migration gives up after five seconds rather than queue every query behind its ACCESS EXCLUSIVE
-- request. The deploy then fails loudly, and a re-run is safe (idempotent above).
SET lock_timeout = '5s';

ALTER TABLE channels ADD COLUMN IF NOT EXISTS "accessRevision" integer NOT NULL DEFAULT 0;
