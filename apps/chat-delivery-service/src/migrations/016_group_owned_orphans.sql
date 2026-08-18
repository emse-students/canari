-- Migration 016: the rows that outlived their group, collected once.
--
-- MEASURED ON PROD 2026-08-18, before this file was written:
--   mls_group_info               69 rows,   21 orphaned (30%)
--   mls_commit_log              452 rows,  293 orphaned (65%)
--   queued_message             1040 rows,  220 orphaned (21%)
--   group_invites                 4 rows,    3 orphaned (75%)
--   dm_user_dismissed_groups     25 rows,    0 orphaned
--   dm_group_members             45 rows,    0 orphaned
--   dm_device_group_memberships  92 rows,    0 orphaned
--
-- Those last two at ZERO are the diagnosis, not a reassurance: `cleanupOrphanedMemberRows` finds
-- orphans by joining FROM the two membership tables, which the tombstone reaper deletes one step
-- before it deletes the group. The sweep was looking in the only two places where nothing ever
-- survives, so the residue accumulated in the tables it never named. `mls_commit_log` at least ages
-- out through `pruneExpiredCommitLog`; `mls_group_info` had no collector of any kind, so those rows
-- were permanent.
--
-- The code half of this shipped in the same commit: `deleteGroupOwnedRows` (utils/group-purge.ts)
-- is now the one allowlist of what a group owns, called by BOTH the tombstone reaper and the orphan
-- sweep, with the `dm_groups` delete in the same transaction. That closes the source. This file only
-- collects what the old code already left behind - it is a one-shot, not a recurring job.
--
-- AN ALLOWLIST, NOT A DENYLIST. Seven tables named one by one, each the same predicate: a `groupId`
-- with no row in `dm_groups`. Nothing selects rows by what they are NOT.
--
-- WHY "group is missing" IS SAFE HERE, given a group row is never recreated: every write path
-- inserts the `dm_groups` row FIRST and the owned row in a later request (a GroupInfo is written
-- after a commit the group must already exist to have accepted; an invite is minted for an existing
-- group). So an orphan is never a half-built group, only a half-deleted one. Note this is a
-- one-shot at deploy time and NOT the shape the runtime sweep uses - a recurring job asking the
-- same question would be racing the reaper that is mid-way through the same deletes.
--
-- NO FOREIGN KEY IS ADDED, and the reason is measured rather than assumed:
-- `dm_user_dismissed_groups."groupId"` is `character varying` while `dm_groups.id` is `uuid`, so a
-- uniform `ON DELETE CASCADE` is not available without first rewriting the type of a live table.
-- The allowlist function is the guarantee instead.
--
-- Idempotent: every DELETE is a no-op on a second pass, and the file is ledgered in
-- `schema_migrations` anyway.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'dm_groups') THEN
    RETURN;
  END IF;

  DELETE FROM queued_message x
    WHERE x."groupId" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM dm_groups g WHERE g.id = x."groupId");

  DELETE FROM dm_group_members x
    WHERE NOT EXISTS (SELECT 1 FROM dm_groups g WHERE g.id = x."groupId");

  DELETE FROM dm_device_group_memberships x
    WHERE NOT EXISTS (SELECT 1 FROM dm_groups g WHERE g.id = x."groupId");

  DELETE FROM mls_commit_log x
    WHERE NOT EXISTS (SELECT 1 FROM dm_groups g WHERE g.id = x."groupId");

  DELETE FROM mls_group_info x
    WHERE NOT EXISTS (SELECT 1 FROM dm_groups g WHERE g.id = x."groupId");

  DELETE FROM group_invites x
    WHERE NOT EXISTS (SELECT 1 FROM dm_groups g WHERE g.id = x."groupId");

  -- Cast: this table stores the id as text, unlike every other one above.
  DELETE FROM dm_user_dismissed_groups x
    WHERE NOT EXISTS (SELECT 1 FROM dm_groups g WHERE g.id::text = x."groupId");
END $$;
