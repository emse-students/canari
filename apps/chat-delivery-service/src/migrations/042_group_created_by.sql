-- Migration 042: dm_groups."createdBy", the account that created the group (2026-10-29).
--
-- The creation route records its authenticated caller here. The creation bootstrap of
-- `POST mls/groups/:id/members` enrols the group's recorded creator (createdBy) and nobody else; a
-- group with no recorded creator is bootstrapped by nobody (re-read under the group's seat lock,
-- `writePendingSeats(..., 'creator')`).
-- Mechanism: docs/wiki/services/chat-delivery.md ("The creation bootstrap admits the creator alone").
--
-- Additive, nullable, NO default and NO backfill: every existing row reads NULL, and NULL means
-- NOBODY may bootstrap that group - refused (403), never admitted. A group with members never takes
-- the bootstrap. No row is rewritten, nothing is deleted.
-- Idempotent: ADD COLUMN IF NOT EXISTS (synchronize creates it in dev; this is for prod).
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `dm_groups`, which the commit gate and the send
-- path read. A nullable column with no default is a catalogue change and rewrites no row, but the
-- lock request would still queue behind a long transaction and stall every reader behind it, so the
-- migration gives up after five seconds instead; the deploy then fails loudly and a re-run is safe.
-- Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

ALTER TABLE "dm_groups"
    ADD COLUMN IF NOT EXISTS "createdBy" VARCHAR(255) NULL;
