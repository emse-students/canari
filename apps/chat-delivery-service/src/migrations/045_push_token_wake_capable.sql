-- Migration 045: whether a device's binary understands a content-free wake-up push (owner,
-- 2026-11-02; docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md).
--
-- `POST /mls/push/register` writes it on EVERY registration: true when the body says `wake: true`,
-- false otherwise - so a build that predates the wake handler, and a downgrade, are never sent a
-- frame they would drop. A wake push goes to a token only when `platform_config.push_mode = 'wake'`
-- (core-service migration 018) AND this column is true; the two locks are ANDed.
--
-- ADDITIVE ONLY: a column with a default. NO BACKFILL - every existing row reads false, which is
-- the truth for every binary registered before this column existed; an upgraded app writes true at
-- its first start (the client re-registers once per process). A release that predates this column
-- never reads it, so a rollback is safe.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `push_token`, which every send reads to find
-- its destinations. Waiting behind a long transaction would stall them behind the queued lock
-- request, so the migration gives up instead; the deploy then fails loudly and a re-run is safe
-- (idempotent). A constant default is a catalogue-only change on PostgreSQL 11+, no table rewrite.
SET lock_timeout = '5s';

ALTER TABLE "push_token" ADD COLUMN IF NOT EXISTS "wakeCapable" boolean NOT NULL DEFAULT false;
