-- Migration 033: a membership interval keeps the ADMISSION that preceded its enrolment
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
-- interval's `joinedAt` gets that row's instant. Open only, and only rows YOUNGER than the person's
-- last `leftAt`: a removal deletes the device rows and closes the interval in two transactions, so
-- a `registerDevice` in between can leave a row of the PREVIOUS membership, which must not date the
-- current stretch (review of #2254). The first arrival the reader derives is unchanged (a stale row
-- is never earlier than the first interval it outlived), so the backfill only makes today's answer
-- survive the next purge. An arrival already erased by a purge before this migration cannot be
-- reconstructed.
--
-- Applied by the deploy itself (`infrastructure/lib/migrations.sh` runs every file its ledger has not
-- recorded), so the release that carries this file IS the application.
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS, and the backfill writes only a NULL column.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `dm_group_membership_intervals`, which every
-- history answer reads. Waiting behind a long transaction would stall them all behind the queued
-- lock request, so the migration gives up instead; the deploy then fails loudly and a re-run is safe
-- (idempotent above). Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

ALTER TABLE dm_group_membership_intervals
    ADD COLUMN IF NOT EXISTS "admittedAt" TIMESTAMP NULL;

UPDATE dm_group_membership_intervals i
SET "admittedAt" = d."firstDeviceAt"
FROM (
    SELECT dg."groupId", dg."userId", MIN(dg."createdAt") AS "firstDeviceAt"
    FROM dm_device_group_memberships dg
    WHERE dg."createdAt" > COALESCE(
        (SELECT MAX(c."leftAt")
         FROM dm_group_membership_intervals c
         WHERE c."groupId" = dg."groupId" AND c."userId" = dg."userId"),
        '-infinity'::timestamp)
    GROUP BY dg."groupId", dg."userId"
) d
WHERE i."groupId" = d."groupId"
  AND i."userId" = d."userId"
  AND i."leftAt" IS NULL
  AND i."admittedAt" IS NULL
  AND d."firstDeviceAt" < i."joinedAt";
