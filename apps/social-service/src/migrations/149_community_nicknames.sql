-- Migration 149: a member's NICKNAME in a community ("Modifier les pseudos", owner 2026-10-14;
-- docs/wiki/frontend/modules/chat.md, "Per-conversation nicknames").
--
-- Three nullable columns on `channel_members`, the membership row: the nickname is scoped to THIS
-- community and dies with the membership (a member who leaves takes no nickname elsewhere).
--
--   nickname            varchar(100) NULL - the name shown for this member in this community; NULL =
--                       none. 100 code points, the profile's limit (libs/contracts/conversation-nickname.json).
--   "nicknameSetBy"     varchar(255) NULL - who set it, or who CLEARED it (a reset is dated like a set,
--                       so a client merging a late event cannot resurrect a cleared name). No foreign
--                       key and no cascade: a nickname STAYS when its setter leaves (owner, 2026-10-18).
--   "nicknameSetAt"     timestamptz NULL - when; NULL on every row nobody ever named.
--
-- The moderator rule is the service's (`CommunityNicknamesService.set`), never a constraint here.
--
-- ADDITIVE: three nullable columns, no default, no CHECK (a catalogue change, no rewrite). The previous
-- release never names them, so a rollback across this migration is harmless; the deploy applies it
-- before any service is replaced (rolling.sh).
-- Idempotent for CD: IF NOT EXISTS.
-- LOCKS: ACCESS EXCLUSIVE on `channel_members` for the catalogue change only; a request holding the
-- lock makes the migration give up after 5 s rather than queue behind it (the re-run is safe).

SET lock_timeout = '5s';

ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS nickname varchar(100);
ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS "nicknameSetBy" varchar(255);
ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS "nicknameSetAt" timestamptz;
