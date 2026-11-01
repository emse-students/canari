-- Migration 043: dm_group_members."joinAskNotified", the one-push-per-ask claim (2026-11-01).
--
-- An invitation-link ask (a seat written awaiting a member's admission) sends ONE ordinary push to
-- the members already admitted ("X veut rejoindre ..."). The ask's identity is the seat row's id, so
-- the claim lives on the row: a conditional UPDATE flips it, and only the caller that flipped it
-- sends. A seat withdrawn by a Decline is deleted and a new link writes a new row, which starts
-- unclaimed - a fresh ask after a Decline is a new push. Durable state, never a timer.
-- Mechanism: docs/wiki/protocols/mls-protocol.md ("The ask reaches a member's phone").
--
-- Additive: NOT NULL DEFAULT false is a catalogue change on PostgreSQL 11+ and rewrites no row.
-- Every existing row reads false, which is right: an ask already on screen when this ships may be
-- pushed once more at its next acceptance, never twice. Nothing is deleted.
-- Idempotent: ADD COLUMN IF NOT EXISTS (synchronize creates it in dev; this is for prod).
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `dm_group_members`, which every send reads. The
-- lock request would queue behind a long transaction and stall every reader behind it, so the
-- migration gives up after five seconds instead; the deploy then fails loudly and a re-run is safe.
-- Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

ALTER TABLE "dm_group_members"
    ADD COLUMN IF NOT EXISTS "joinAskNotified" BOOLEAN NOT NULL DEFAULT false;
