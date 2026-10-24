-- Migration 038: a roster seat that waits for a MEMBER's admission (decided by the user 2026-10-23:
-- a new person joins a group only through a member - docs/wiki/protocols/mls-protocol.md, "Who admits
-- a new person").
--
-- `POST mls/group-invites/:token/accept` puts the person on the roster with `pending` device seats,
-- and members no longer Add a person who holds no leaf on the strength of a server row: the ask is
-- shown to a member (Add / Decline). A seat on the roster was ALSO the whole of what let its owner
-- read the external-join base and have an external commit accepted, so the joiner admitted itself
-- within one recovery cadence, around the member it was waiting for. This column carries the fact
-- that is known only here - the seat was written by a link, not by a member's Add - to the two
-- places that decide: the commit gate and the base refuse it, and `GET mls/device-memberships`
-- tells the joiner to wait rather than join.
--
-- Written `true` by the link acceptance alone; cleared by the first accepted commit that ADMITS one
-- of the person's devices (a member's Add, `validateCommit`). Every other writer leaves the default.
--
-- Additive, NOT NULL DEFAULT false: a constant default rewrites no row (PostgreSQL 11+), and every
-- existing seat - all of them written before this rule or by a member - reads `false`. That is right
-- for every admitted member, and NOT for a link seat whose person had not entered yet when this ran:
-- such a seat reads as no ask at all, so nobody is asked in that person's name and a member's own
-- invite is what brings them in (a one-off population, counted in docs/wiki/legacy-compatibility.md).
-- Idempotent: ADD COLUMN IF NOT EXISTS.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `dm_group_members`, which every send reads to
-- authorise its sender. Waiting behind a long transaction would stall them behind the queued lock
-- request, so the migration gives up instead; the deploy then fails loudly and a re-run is safe.
-- Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

ALTER TABLE "dm_group_members"
    ADD COLUMN IF NOT EXISTS "awaitingAdmission" BOOLEAN NOT NULL DEFAULT false;
