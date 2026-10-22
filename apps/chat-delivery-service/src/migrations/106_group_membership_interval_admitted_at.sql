-- Migration 106: a membership interval keeps the ADMISSION that preceded its enrolment
-- (review of #2226, 2026-10-22).
--
-- A group conversation withholds from a person everything before their first arrival, and that
-- arrival is the EARLIER of their first interval and their first device row in the group (added =
-- arrived: a commit can admit an invitee's device days before their enrolment opens the interval).
-- Device rows are not durable: revoking a device (`purgeDeviceFootprint`) deletes them, so for a
-- member enrolled late the arrival moved later and their next device lost the span between the two.
-- `ensureGroupMember` now copies the earliest device row onto the interval it opens; this column
-- holds it. It decides the before-arrival span and the start of the caller's stretch for `for`,
-- never a gap. Design: docs/wiki/protocols/history-reconciliation.md.
--
-- BACKFILL: every OPEN interval whose person holds a device row in the group older than the
-- interval's `joinedAt` gets that row's instant. Open only: a removal deletes the person's device
-- rows, so any row present belongs to the current stretch. This is exactly what the reader derives
-- from the device rows today, so the backfill changes no answer - it only makes the current answer
-- survive the next purge. An arrival already erased by a purge before this migration cannot be
-- reconstructed.
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS, and the backfill writes only a NULL column.

ALTER TABLE dm_group_membership_intervals
    ADD COLUMN IF NOT EXISTS "admittedAt" TIMESTAMP NULL;

UPDATE dm_group_membership_intervals i
SET "admittedAt" = d."firstDeviceAt"
FROM (
    SELECT "groupId", "userId", MIN("createdAt") AS "firstDeviceAt"
    FROM dm_device_group_memberships
    GROUP BY "groupId", "userId"
) d
WHERE i."groupId" = d."groupId"
  AND i."userId" = d."userId"
  AND i."leftAt" IS NULL
  AND i."admittedAt" IS NULL
  AND d."firstDeviceAt" < i."joinedAt";
