-- Migration 044: dm_device_group_memberships."admittedByBaseEpoch", the commit that admitted a seat (2026-11-02).
-- canari:hold-for-owner: it backfills every existing seat (approved by the owner, 2026-11-02, "Oui, dans la file")
--
-- `GET mls/commits/:groupId/accepted-at` answers a device the acceptance time of the commit that
-- admitted it and of every later one, never of an older one (`commitFloorOf`). That floor was read
-- as "the last commit accepted at or before the arrival", and the arrival records could predate the
-- admission (a group stretch's `joinedAt`, a re-added device's first `createdAt`), so it handed out
-- one commit, or a stretch, from before it. The commit gate now records the admitting commit's base
-- epoch on the seat, on every admission, and the floor is read from it alone.
-- Mechanism: docs/wiki/frontend/modules/chat.md ("A visible notice is dated by its frame").
--
-- THE BACKFILL - REFUSE RATHER THAN LEAK. A seat with no value is answered nothing, so every row
-- existing at the deploy is given the floor the server can still prove, and never a lower one:
--   1. a seat a commit admitted and that has not activated yet still holds the epoch that commit
--      created (`admittedAtEpoch`), so its floor is exact: that epoch minus one;
--   2. an ACTIVE seat is floored at its group's current epoch: no commit accepted before this
--      migration is answered to it, every later one is. Its true admission is not recorded
--      anywhere a clock could not have moved, so the stretch it may have been out for is refused,
--      not guessed. The cost, taken knowingly: a line about a commit accepted before the deploy and
--      merged after it is settled undated;
--   3. any other `pending` seat (enrolled and never admitted, or kicked and not re-added) keeps
--      NULL: no commit admitted it, so it is refused until one does.
-- No row is deleted. Idempotent: ADD COLUMN IF NOT EXISTS, and each UPDATE touches NULLs only.
-- ONE TRANSACTION, so the column is never visible half backfilled.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `dm_device_group_memberships`, which every
-- send's fan-out and every commit read. A nullable column with no default rewrites no row, but the
-- lock request would still queue behind a long transaction and stall every reader behind it, so the
-- migration gives up after five seconds instead; the deploy then fails loudly and a re-run is safe.
-- Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

BEGIN;

ALTER TABLE "dm_device_group_memberships"
    ADD COLUMN IF NOT EXISTS "admittedByBaseEpoch" INTEGER NULL;

UPDATE "dm_device_group_memberships"
   SET "admittedByBaseEpoch" = "admittedAtEpoch" - 1
 WHERE "admittedByBaseEpoch" IS NULL
   AND "admittedAtEpoch" IS NOT NULL;

UPDATE "dm_device_group_memberships" d
   SET "admittedByBaseEpoch" = g."activeEpoch"
  FROM "dm_groups" g
 WHERE g.id = d."groupId"
   AND d."admittedByBaseEpoch" IS NULL
   AND d.status = 'active';

COMMIT;
