-- canari:hold-for-owner - DESTRUCTIVE: deletes the conversation seats of people who hold no device at all (owner, 2026-11-14).
-- Migration 051: a conversation seat whose person has no device left anywhere is removed.
--
-- docs/wiki/backlog.d/reading-owed-the-pre-038-link-seats-the-group-panel-would-list-as-members.md.
-- Counted on production 2026-11-14, read-only: 22 of the 770 seats not awaiting a member hold no
-- active device of their person in their group. 18 of them (16 people, 16 conversations) are the
-- shape this file removes; the other 4 are `pending` rows of a join that never completed, and are
-- KEPT. The owner, asked whether to drop the 18: "Oui, les retirer".
--
-- WHY THEY EXIST, AND WHY THEY WILL EXIST AGAIN. A conversation seat (`dm_group_members`) is kept
-- when its person's devices go, BY DESIGN: it is what lets recovery re-invite a person who comes back
-- on a new device (`GroupMember`'s doc; `MessagingService.purgeDeviceFootprint`: "conversations need
-- none: their seat stays"). The 16 people still have an account; 13 had their last device revoked,
-- 12 of them in the week of the fourth orphan-device pass (2026-11-01), and 3 lost theirs to the
-- 90-day GC. So nothing wrote these seats wrongly: the next revocation of a person's LAST device
-- leaves the same shape. Whether a seat should end with its person's last device - which costs a
-- returning person every conversation - is the owner's question, parked in open-questions.md; this
-- file removes the population that exists today, as decided.
--
-- THE ALLOWLIST - a seat is removed only when ALL of these hold, read under its group's seat lock:
--   * it does not await a member's admission (`awaitingAdmission` false - an open ask is a Decline's);
--   * its person has NO `dm_device_group_memberships` row in that group, of any status (a `pending`
--     row is a join in flight, an `active` one a member);
--   * its person has NO `dm_device_group_memberships` row in ANY group;
--   * its person holds NO `key_package` row (no device enrolled anywhere, live or stale).
-- A person who came back before this runs holds a key package again, and keeps every seat.
--
-- WHAT IT DOES, as a removal does it (`MembersController.removeGroupMember`, `endGroupMembership`),
-- in the one order of `utils/seat-eviction.ts`: the seat lock of every group touched (taken in
-- group-id order, so this transaction never waits on a writer in a cycle), then the group's seat
-- generation moved (an Add built before this removal cannot re-enrol the person afterwards), then
-- the roster row deleted and its open interval closed at the new generation (a later re-add does not
-- hand the person what was sent while they were out). There is no device row, queued Welcome or
-- gateway route to end: the allowlist requires none. No `dm_seat_evictions` row is written - a
-- removal's eviction record creates no row (`recordSeatEviction(..., false)`), and none of the 18
-- has one.
--
-- THE COPY BEFORE THE DELETE: every removed roster row, whole (`to_jsonb`), and the ids of the
-- intervals this closed, go to `dm_group_members_removed_051` in the same transaction. It names
-- people, so it is NOT kept: it is dropped by a later migration once the readings in the backlog
-- entry pass. The deploy takes a full dump right before this file as well (an approved held file is
-- applied only after `migration_backup` succeeded).
--
-- WHAT IT LOGS: one NOTICE with the counts (seats before, matched, removed, intervals closed, seats
-- after) - never an id: the deploy's output is read outside the database.
--
-- Idempotent for CD: a second run matches no seat (the first deleted them) and copies nothing.
-- LOCKS: row locks on the matched seats, their intervals and their groups' rows, plus the seat
-- advisory locks, all released at COMMIT; a concurrent writer waits for it, and this gives up after
-- 5 s rather than queue (the re-run is safe).
--
-- ROLLBACK BEGIN (run as written; asserted by `051_departed_seats_removed.integration.spec.ts`)
--   INSERT INTO dm_group_members SELECT (jsonb_populate_record(NULL::dm_group_members, r.seat)).* FROM dm_group_members_removed_051 r ON CONFLICT DO NOTHING;
--   UPDATE dm_group_membership_intervals i SET "leftAt" = NULL, "leftAtSeatGeneration" = NULL FROM dm_group_members_removed_051 r WHERE i.id = ANY(r."closedIntervalIds");
-- ROLLBACK END
-- The seat generations it moved stay moved: a generation only names an ordering, and a higher one
-- refuses at most one overtaken claim, which its writer retries.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS dm_group_members_removed_051 (
    "seatId" uuid PRIMARY KEY,
    "seat" jsonb NOT NULL,
    "closedIntervalIds" uuid[] NOT NULL,
    "removedAt" timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')
);

DO $$
DECLARE
    seats_before integer;
    matched integer;
    removed integer;
    closed integer;
    seats_after integer;
    g uuid;
BEGIN
    SELECT count(*) INTO seats_before FROM dm_group_members;

    -- 1. The seat lock of every group holding such a seat, in group-id order - the key
    --    `utils/seat-eviction.ts` takes (`seat:<groupId>`).
    FOR g IN
        SELECT DISTINCT m."groupId"
          FROM dm_group_members m
         WHERE NOT m."awaitingAdmission"
           AND NOT EXISTS (SELECT 1 FROM dm_device_group_memberships d WHERE d."userId" = m."userId")
           AND NOT EXISTS (SELECT 1 FROM key_package k WHERE k."userId" = m."userId")
         ORDER BY 1
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('seat:' || g::text, 0));
    END LOOP;

    -- 2. The allowlist, read again under the locks. "No device row anywhere" implies "none in the
    --    group"; both are named in the header because both were measured.
    CREATE TEMP TABLE departed_051 ON COMMIT DROP AS
        SELECT m.*
          FROM dm_group_members m
         WHERE NOT m."awaitingAdmission"
           AND NOT EXISTS (SELECT 1 FROM dm_device_group_memberships d
                            WHERE d."userId" = m."userId" AND d."groupId" = m."groupId")
           AND NOT EXISTS (SELECT 1 FROM dm_device_group_memberships d WHERE d."userId" = m."userId")
           AND NOT EXISTS (SELECT 1 FROM key_package k WHERE k."userId" = m."userId");
    SELECT count(*) INTO matched FROM departed_051;

    -- 3. The groups' seat generations, moved first under the locks, as every removal does.
    UPDATE dm_groups SET "seatGeneration" = "seatGeneration" + 1
     WHERE id IN (SELECT DISTINCT "groupId" FROM departed_051);

    -- 4. The copy, whole, with the intervals step 6 closes.
    INSERT INTO dm_group_members_removed_051 ("seatId", "seat", "closedIntervalIds")
    SELECT d.id,
           to_jsonb(d),
           ARRAY(SELECT i.id FROM dm_group_membership_intervals i
                  WHERE i."groupId" = d."groupId" AND i."userId" = d."userId" AND i."leftAt" IS NULL)
      FROM departed_051 d
        ON CONFLICT ("seatId") DO NOTHING;

    -- 5. The roster rows.
    DELETE FROM dm_group_members m USING departed_051 d WHERE m.id = d.id;
    GET DIAGNOSTICS removed = ROW_COUNT;

    -- 6. Their open intervals, closed at the generation step 3 moved the group to.
    UPDATE dm_group_membership_intervals i
       SET "leftAt" = now() AT TIME ZONE 'UTC',
           "leftAtSeatGeneration" = grp."seatGeneration"
      FROM departed_051 d
      JOIN dm_groups grp ON grp.id = d."groupId"
     WHERE i."groupId" = d."groupId" AND i."userId" = d."userId" AND i."leftAt" IS NULL;
    GET DIAGNOSTICS closed = ROW_COUNT;

    SELECT count(*) INTO seats_after FROM dm_group_members;
    RAISE NOTICE 'migration 051: % seat(s) before, % matched the departed-seat allowlist, % removed, % interval(s) closed, % seat(s) after',
        seats_before, matched, removed, closed, seats_after;
END $$;
