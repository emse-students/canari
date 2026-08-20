-- Frees the distribution scope held by an ALREADY-tombstoned group.
--
-- WHY IT EXISTS. `deletedAt` on `dm_groups` is a plain column, not a TypeORM `@DeleteDateColumn`,
-- so a tombstoned row is still returned by an ordinary `findOne`. The scope columns carry partial
-- unique indexes that do NOT exclude tombstones. Together those two facts meant that retiring a
-- private salon's group and then making the salon private again handed the salon back the group it
-- had just retired - a row `cleanupSoftDeletedGroups` is counting down to delete, whose MLS tree
-- still held the old roster. Found 2026-08-20 by flipping a real salon on production.
--
-- `deleteDistributionGroup` now clears the scope in the same write. This releases the scopes of the
-- rows tombstoned before that change, so the invariant "at most one LIVE group per scope, and a
-- tombstone occupies no scope" holds for the whole table rather than from today onwards.
--
-- Safe to re-run: it only touches rows that are both tombstoned and still holding a scope.
UPDATE dm_groups
SET "distributionWorkspaceId" = NULL,
    "distributionChannelId" = NULL
WHERE "deletedAt" IS NOT NULL
  AND ("distributionWorkspaceId" IS NOT NULL OR "distributionChannelId" IS NOT NULL);
