-- Migration 050: which GROUP call this device's binary can take part in (WP-GC2, 2026-11-13;
-- docs/wiki/frontend/modules/calls.md#group-calls-the-mesh-wp-gc2-2026-11-13).
--
-- `push_token."groupCallVersion"`: 0 none, 1 the peer-to-peer mesh (one connection and one key per
-- other participant, addressed signalling). Written on EVERY `POST /mls/push/register`, 0 unless the
-- body says otherwise - an absent field is a statement: the build predates group calls. A GROUP
-- call's ring is pushed only to devices at `>= 1`, so an old binary is never rung for a call it
-- would join as a 1:1 call and break (`CallsService.fanOutRing`). NO BACKFILL: every app start
-- re-registers and writes its real version.
--
-- ADDITIVE ONLY: one column with a constant default. A release that predates it reads nothing of
-- it, so a rollback is safe.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `push_token`, which every send reads. The
-- migration gives up after five seconds rather than queue behind a long transaction; the deploy then
-- fails loudly and a re-run is safe (idempotent). A constant default is a catalogue-only change on
-- PostgreSQL 11+, no table rewrite.
SET lock_timeout = '5s';

ALTER TABLE "push_token" ADD COLUMN IF NOT EXISTS "groupCallVersion" integer NOT NULL DEFAULT 0;
