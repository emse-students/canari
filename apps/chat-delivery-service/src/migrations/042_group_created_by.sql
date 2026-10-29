-- Migration 042: dm_groups."createdBy", the account that created the group (2026-10-29).
--
-- `POST mls/groups/:id/members` enrols ONE person itself: a group's creator, into its still-empty
-- roster (the creation bootstrap). "The roster is empty" was the whole test, so anyone who knew the id
-- of a group whose roster was still empty enrolled themselves as its first ADMITTED member. The
-- creation route now records its authenticated caller here, and the bootstrap admits that account
-- alone, re-read under the group's seat lock (`writePendingSeats(..., 'creator')`).
-- Mechanism: docs/wiki/services/chat-delivery.md ("The creation bootstrap admits the creator alone").
--
-- Additive, nullable, NO default and NO backfill: every existing row reads NULL, and NULL means
-- NOBODY may bootstrap that group - refused (403), never admitted. That is safe for every row this
-- runs on: a group with members never takes the bootstrap, and an existing group whose roster is
-- still empty has no creator anyone can name now. No row is rewritten, nothing is deleted.
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
