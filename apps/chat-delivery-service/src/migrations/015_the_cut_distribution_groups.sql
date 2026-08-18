-- WP-60, THE CUT, delivery half: the distribution groups of the communities being deleted go too.
--
-- social-service's migration 042 deletes every community in the same deploy. A community's Graine
-- key-distribution group lives HERE, in `dm_groups`, marked by `distributionWorkspaceId` - so
-- without this it would survive as an MLS group whose community no longer exists, which is exactly
-- the orphan shape the 2026-08-17 purge had to find by hand.
--
-- AN ALLOWLIST, NOT A DENYLIST. Every statement is scoped through
-- `dm_groups."distributionWorkspaceId" IS NOT NULL`. These rows are the only ones this migration
-- may touch, and an ordinary conversation must never be reachable from it - "delete the groups that
-- are not conversations" would have been one wrong predicate away from deleting every DM on the
-- platform.
--
-- HARD DELETE HERE, THOUGH `deleteDistributionGroup` TOMBSTONES. That route soft-deletes on
-- purpose, so the community's group dies of the same lifecycle every other group dies of and no
-- second one exists. A tombstone is the right answer when ONE community goes and the rest of the
-- system keeps running; it is the wrong one here, because every one of these rows would spend the
-- next ninety days naming a workspace that no longer exists, and the reaper that eventually
-- collects them touches neither `mls_commit_log` nor `mls_group_info`. This is the one-shot cut, so
-- it names every table itself.
--
-- Idempotent: each DELETE is a no-op on a second pass, and the whole file is ledgered in
-- `schema_migrations` so it runs once per host anyway.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'dm_groups') THEN
    DELETE FROM mls_commit_log c
      USING dm_groups g
      WHERE c."groupId" = g.id AND g."distributionWorkspaceId" IS NOT NULL;

    DELETE FROM mls_group_info i
      USING dm_groups g
      WHERE i."groupId" = g.id AND g."distributionWorkspaceId" IS NOT NULL;

    DELETE FROM queued_message q
      USING dm_groups g
      WHERE q."groupId" = g.id AND g."distributionWorkspaceId" IS NOT NULL;

    DELETE FROM dm_device_group_memberships m
      USING dm_groups g
      WHERE m."groupId" = g.id AND g."distributionWorkspaceId" IS NOT NULL;

    DELETE FROM dm_group_members m
      USING dm_groups g
      WHERE m."groupId" = g.id AND g."distributionWorkspaceId" IS NOT NULL;

    DELETE FROM dm_groups WHERE "distributionWorkspaceId" IS NOT NULL;
  END IF;
END $$;
