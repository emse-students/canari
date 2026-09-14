-- WHEN THIS ROW ENTERED `pending`, WRITTEN BY THE TRANSITION AND BY NOTHING ELSE.
--
-- `cleanupStalePendingInvitations` and `reportStrandedDeviceMemberships` both asked how long a
-- roster seat had been waiting, and both read `updatedAt` for the answer. `updatedAt` is a TypeORM
-- `@UpdateDateColumn`: it moves for every write, and the writers are OTHER people's clients - a
-- Welcome being queued, a peer confirming an invitation, the commit-path activation. The same
-- premise was refuted on this very table by WP-GHOST-1, and `detectStaleDevices` carries the rule
-- twenty lines above the purge: "a liveness clock must be written by the thing whose liveness it
-- measures". The purge was measuring somebody else's activity.
--
-- MEASURED ON PRODUCTION 2026-09-14: 91 pending seats, the 14-day purge holding 90 of them inside
-- its window - and ONE created 32 days ago whose `updatedAt` was 2 days old. Its grace window had
-- been reset by a write it had no part in, and nothing in the schema could ever let it expire.
--
-- Backfilled from `createdAt`, which is the instant every existing row entered `pending` unless a
-- demotion moved it - and a demotion that is not recorded anywhere cannot be recovered, so the
-- conservative reading is the one that lets the purge reach the rows it was always meant to reach.
-- NOT NULL with a `now()` default, so a row inserted by any of the five creation sites - or a sixth
-- added later - carries it without opting in.
ALTER TABLE dm_device_group_memberships
  ADD COLUMN IF NOT EXISTS "pendingSince" timestamptz;

UPDATE dm_device_group_memberships
  SET "pendingSince" = "createdAt"
  WHERE "pendingSince" IS NULL;

ALTER TABLE dm_device_group_memberships
  ALTER COLUMN "pendingSince" SET DEFAULT now();

ALTER TABLE dm_device_group_memberships
  ALTER COLUMN "pendingSince" SET NOT NULL;

-- The purge and the hourly report both scan `status = 'pending'` ordered by this column.
CREATE INDEX IF NOT EXISTS "IDX_dgm_status_pending_since"
  ON dm_device_group_memberships ("status", "pendingSince");
