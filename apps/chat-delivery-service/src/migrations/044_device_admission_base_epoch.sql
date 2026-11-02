-- Migration 044: dm_device_group_memberships."admittedByBaseEpoch", the commit that admitted a seat (2026-11-02).
-- canari:hold-for-owner: it backfills every existing seat (approved by the owner, 2026-11-02, "Oui, dans la file")
--
-- `GET mls/commits/:groupId/accepted-at` answers a device the acceptance time of the commit that
-- admitted it and of every later one, never of an older one (`commitFloorOf`). That floor was read
-- as "the last commit accepted at or before the arrival", and the arrival records could predate the
-- admission (a group stretch's `joinedAt`, a re-added device's first `createdAt`), so it handed out
-- one commit, or a stretch, from before it. The commit gate now records the admitting commit's base
-- epoch on the seat, on every admission, and the floor is read from it alone.
-- "admissionInferred" says when that floor is NOT an admission but the group's epoch, inferred where
-- none was recorded (this backfill, or the first ask that finds a seat with none) - read only to say
-- which floor refused, in the refusal's log line.
-- Mechanism: docs/wiki/frontend/modules/chat.md ("A visible notice is dated by its frame").
--
-- THE BACKFILL - REFUSE RATHER THAN LEAK. Every row existing at the deploy is given the floor the
-- server can still prove, and never a lower one:
--   1. a pending seat a commit admitted and that has not activated yet still holds the epoch that
--      commit created ("admittedAtEpoch"): its floor is exact, that epoch minus one;
--   2. an ACTIVE seat, and a pending seat that was never KICKED (the stale-device cron demotes an
--      active seat to pending and clears "admittedAtEpoch" but leaves its leaf in the tree, and a
--      report may re-activate it with no commit): floored at its group's current epoch, inferred.
--      No commit accepted before this migration is answered to it, every later one is. Its true
--      admission is recorded nowhere a clock could not have moved, so the stretch it may have been
--      out for is refused, not guessed. The cost, taken knowingly: a line about a commit accepted
--      before the deploy and merged after it is settled undated;
--   3. a KICKED seat (pending, "kickedAt" set) keeps NULL: its leaf is out of the tree, and it is
--      refused until the Add that answers the kick records a new admission.
-- Seats a replica still running the old code admits after this runs are floored the same way by
-- their first ask (`commitFloorOf`), written once. No row is deleted. Idempotent: ADD COLUMN IF NOT
-- EXISTS, and each UPDATE touches NULLs only.
--
-- THE ALTER IS ALONE, AND THE BACKFILL OUTSIDE ITS LOCK. ADD COLUMN takes ACCESS EXCLUSIVE on
-- `dm_device_group_memberships`, which every send's fan-out and every commit read. A nullable
-- column and a constant default rewrite no row, so the ALTER is a catalogue change; it gives up
-- after five seconds rather than queue behind a long transaction and stall every reader behind it
-- (the deploy then fails loudly and a re-run is safe; asserted by `migrations.lock-timeout.spec.ts`).
-- psql commits it on its own, so the two UPDATEs below take row locks only, never the table lock:
-- a concurrent write to a seat waits for its one row. One row per device per group: 10 rows on dev
-- (2026-11-02); production's count is read before the release (the query is in the pull request).
SET lock_timeout = '5s';

ALTER TABLE "dm_device_group_memberships"
    ADD COLUMN IF NOT EXISTS "admittedByBaseEpoch" INTEGER NULL,
    ADD COLUMN IF NOT EXISTS "admissionInferred" BOOLEAN NOT NULL DEFAULT false;

UPDATE "dm_device_group_memberships"
   SET "admittedByBaseEpoch" = "admittedAtEpoch" - 1
 WHERE "admittedByBaseEpoch" IS NULL
   AND "admittedAtEpoch" IS NOT NULL
   AND status = 'pending';

UPDATE "dm_device_group_memberships" d
   SET "admittedByBaseEpoch" = g."activeEpoch",
       "admissionInferred" = true
  FROM "dm_groups" g
 WHERE g.id = d."groupId"
   AND d."admittedByBaseEpoch" IS NULL
   AND (d.status = 'active' OR d."kickedAt" IS NULL);
