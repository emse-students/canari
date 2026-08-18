-- Migration 039: what a community lets a newcomer read.
--
-- Per COMMUNITY, not per channel. A member belongs to the community, joins its one distribution
-- group and receives seeds through it; a rule that differed per salon would be a rule nobody could
-- state and nobody could enforce - the seeds of every salon travel on the same group.
--
-- 'shared' is the default and hands the past over: a newcomer receives the seeds their answerer
-- holds, and reads history exactly as far back as that member could. 'joined' hands over nothing
-- written before the join - the seeds a member receives afterwards start at the index in force when
-- they arrived.
--
-- The consequence of 'shared' is deliberate and recorded rather than discovered later: "read the
-- past" and "the past's keys disappear" cannot both be true, in any protocol
-- (docs/wiki/protocols/channel-encryption.md, the user's decision of 2026-08-17).
--
-- NOT NULL with a default, unlike 037's nullable pointer: there is no such thing as a community
-- with no answer to this question, and a null would be a third state every reader would have to
-- interpret - which is how a default ends up spelled differently in three places.
--
-- Column is double-quoted camelCase to match TypeORM's default naming (see migration 029).
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when the column already exists.

BEGIN;

ALTER TABLE channel_workspaces
  ADD COLUMN IF NOT EXISTS "historyVisibility" VARCHAR(16) NOT NULL DEFAULT 'shared';

COMMIT;
