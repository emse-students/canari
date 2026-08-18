-- Migration 040: a reaction stops being a column the server can read.
--
-- `channel_messages.reactions` was a cleartext jsonb tally (`emoji -> userIds`). After Graine the
-- server cannot read "j'arrive" but could still see that eight people put a heart on it - that is
-- content, and an exception like it hollows out the guarantee. A reaction is an encrypted channel
-- message now, sealed under its sender's Graine session like any other
-- (docs/wiki/protocols/channel-encryption.md).
--
-- `silent` is what replaces the ONE thing the server legitimately needed to know: whether a row
-- should ring a phone. It is a boolean and nothing more - not which emoji, not on what, not by
-- whom - and it is what keeps a burst of reactions from silently pushing older messages out of a
-- 200-row page: the listing fills its page with non-silent rows and adds the silent rows that fall
-- inside it.
--
-- The tally is DROPPED rather than kept for a window: the migration to Graine is a clean cut, every
-- community is deleted at deploy, and a column nothing writes is a column somebody will read.
--
-- Column is double-quoted camelCase to match TypeORM's default naming (see migration 029).
-- Idempotent in both directions: IF NOT EXISTS / IF EXISTS.

BEGIN;

ALTER TABLE channel_messages
  ADD COLUMN IF NOT EXISTS "silent" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE channel_messages
  DROP COLUMN IF EXISTS "reactions";

COMMIT;
