-- Migration 039: order a conversation departure against the epoch a commit was built on, by a
-- counter (2026-10-25, the review of #2419).
--
-- The commit gate enrols the people an accepted Add admits (`enrolAdmittedPeople`). An Add built
-- BEFORE a person left or was removed can still land afterwards when nobody committed in between -
-- a self-leave makes no commit, and a removal's Remove commit can be lost - and it must not re-enrol
-- them: a removal holds against a later re-add (user, 2026-10-14). The group's `seatGeneration`
-- already moves under the seat lock at every removal (migration 036), and now at a member's Decline
-- of an invitation-link ask; these columns record it at the events the gate compares:
--   dm_groups."epochSeatGeneration"                      - the generation the current epoch began at,
--                                                          written by the advance that created it;
--   dm_group_membership_intervals."leftAtSeatGeneration" - the generation a removal closed the
--                                                          stretch at;
--   dm_seat_evictions."declinedAtSeatGeneration"         - the generation a Decline moved the group
--                                                          to (a Decline deletes the ask's interval
--                                                          rather than closing it, so it cannot carry
--                                                          the stamp).
-- A departure recorded at a LATER generation than the epoch's came after every commit still able to
-- land at that epoch was built, so the gate does not enrol that person.
--
-- Additive: a constant default rewrites no row (PostgreSQL 11+). An epoch begun before this reads 0
-- and a departure recorded before this reads NULL (never compared as later) - so a departure older
-- than the deploy refuses nothing, and one recorded after it refuses as designed. Idempotent: ADD
-- COLUMN IF NOT EXISTS.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `dm_groups`, which every commit reads, on
-- `dm_group_membership_intervals`, which every history answer reads, and on `dm_seat_evictions`,
-- which every seat claim reads. Waiting behind a long
-- transaction would stall them behind the queued lock request, so the migration gives up instead;
-- the deploy then fails loudly and a re-run is safe. Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

ALTER TABLE "dm_groups"
    ADD COLUMN IF NOT EXISTS "epochSeatGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "dm_group_membership_intervals"
    ADD COLUMN IF NOT EXISTS "leftAtSeatGeneration" INTEGER NULL;

ALTER TABLE "dm_seat_evictions"
    ADD COLUMN IF NOT EXISTS "declinedAtSeatGeneration" INTEGER NULL;
