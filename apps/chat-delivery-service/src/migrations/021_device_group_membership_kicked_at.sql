-- WHEN THIS ROW WAS RESET BY A KICK, AND NULL MEANS "NOT BY A KICK".
--
-- A `pending` row with no queued Welcome is the platform's only witness that a device holds a group
-- seat it was never given the keys for - `reportStrandedDeviceMemberships`, hourly. Two opposite
-- causes wear that footprint and want opposite fixes, and until this column nothing on the server
-- could tell them apart:
--
--   * `addMembersBulk` SKIPPED the device's KeyPackage, so it was never in the MLS tree at all. The
--     fix is in the inviter's KeyPackage handling.
--   * a member REMOVED the device's stale leaf and the re-add that was supposed to follow threw. The
--     device WAS in the tree; the fix is wherever that Add failed, and nothing reported it - the
--     failure is swallowed on the answering device, which is a phone whose log nobody reads.
--
-- Written by the two kick endpoints, which are the only things that reset a live membership, and
-- cleared by the three writes that answer the question the other way: a Welcome queued for the
-- device (the re-add landed), and either path that marks it `active` (it is in). Not cleared on a
-- demotion to `pending`, which is a step towards cleanup and promises no Add.
--
-- Nullable, and null is the answer for every row that exists today: this cannot be backfilled, and
-- pretending otherwise would date every historical row to the deploy. The first hourly pass after
-- this therefore reports the whole backlog as "never added", which is the honest reading of "no kick
-- is recorded" - it becomes exact as the population turns over.
ALTER TABLE "dm_device_group_memberships" ADD COLUMN IF NOT EXISTS "kickedAt" TIMESTAMPTZ;

-- The report reads (status, kickedAt) over a population already bounded by the 14-day purge, so this
-- is for the hourly scan rather than for size: `status` alone matches every pending row on the
-- estate, and the partial index is the one that answers the question being asked.
CREATE INDEX IF NOT EXISTS "idx_dgm_kicked_pending"
  ON "dm_device_group_memberships" ("kickedAt")
  WHERE "status" = 'pending' AND "kickedAt" IS NOT NULL;
