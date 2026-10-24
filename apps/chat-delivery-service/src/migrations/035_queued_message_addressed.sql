-- Migration 035: whether a queued row was ADDRESSED to its device rather than fanned out to the group
-- (step A of "a new member of a group conversation receives its whole past", 2026-10-22).
--
-- A history answer on a conversation is now sent to the asking device alone (`recipientDevices`).
-- MLS still encrypts it for the whole group, so the RECEIVER must know the server routed it to it
-- alone: it then accepts the frame only as a solicited, bounded `history_bundle` and refuses any
-- other content at error - which is what stops a member from showing one device a message the rest
-- of the group never sees. The flag reaches the client on the live frame and on the pull.
--
-- Additive, no data rewrite: every existing row reads false, which is what it was (no conversation
-- row was ever addressed; key-group seed answers were, and their receiver ignores the flag).
-- Idempotent: ADD COLUMN IF NOT EXISTS. Design: docs/wiki/protocols/history-answer-addressing.md.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `queued_message`, the table every send writes
-- and every pull reads. Waiting behind a long transaction would stall all of them behind the queued
-- lock request, so the migration gives up instead; the deploy then fails loudly and a re-run is safe
-- (idempotent above). Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

ALTER TABLE queued_message
    ADD COLUMN IF NOT EXISTS "addressed" BOOLEAN NOT NULL DEFAULT false;
