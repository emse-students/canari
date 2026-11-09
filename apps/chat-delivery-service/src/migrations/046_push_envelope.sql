-- Migration 046: the push envelope, and the wake capability as a version (content-free push WP-W3;
-- docs/wiki/protocols/content-free-push.md, sections 3.2 and 8).
--
-- `push_envelope` holds, per DEVICE, what a push sent through `sendPushToUser` (salons, social and
-- bell pushes, chat reactions, join asks) would have carried, while the device was sent only a
-- content-free wake naming the envelope's random id. `GET /mls/push/wake?envelopeId=` answers it.
-- Serving does NOT delete (a lost response would read as `gone`): it marks `servedAt` and counts.
-- An envelope dies by a proof, never a clock:
--   1. its device's push registration is deleted - the foreign key below, ON DELETE CASCADE, so a
--      session end, a revocation, an invalid token or an account erasure takes its envelopes;
--   2. the device registers again (`POST /mls/push/register`, once per app process) - the app is
--      open and reads everything over HTTP, so every envelope of that device is swept;
--   3. a per-device cap (`MAX_ENVELOPES_PER_DEVICE`), silent envelopes evicted first.
--
-- `push_token."wakeVersion"`: what the binary understands - 0 none, 1 the MLS wake (what
-- `"wakeCapable" = true` says), 2 the envelope wake too. Written on EVERY registration.
-- NO BACKFILL: a row at 0 is sent the full push, which is the contract its binary was registered
-- under; every app start re-registers and writes its real version. `"wakeCapable"` is still written
-- on every registration, for a rollback to a server that reads it, and is dropped later by a held
-- migration of its own (WP-W3c).
--
-- ADDITIVE ONLY: a new column with a constant default, a new table, its indexes. A release that
-- predates it reads neither, so a rollback is safe.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `push_token`, and the foreign key takes SHARE
-- ROW EXCLUSIVE on it; every send reads that table. The migration gives up after five seconds rather
-- than queue behind a long transaction; the deploy then fails loudly and a re-run is safe
-- (idempotent). A constant default is a catalogue-only change on PostgreSQL 11+, no table rewrite.
SET lock_timeout = '5s';

ALTER TABLE "push_token" ADD COLUMN IF NOT EXISTS "wakeVersion" integer NOT NULL DEFAULT 0;

-- The foreign key needs the unique ("userId", "deviceId") index `PushToken` declares; the
-- registration's upsert already relies on it (`conflictPaths`).
CREATE TABLE IF NOT EXISTS "push_envelope" (
    "id"          uuid PRIMARY KEY,
    "userId"      varchar(255) NOT NULL,
    "deviceId"    varchar NOT NULL,
    "payload"     jsonb NOT NULL,
    "silent"      boolean NOT NULL,
    "collapseKey" varchar(255),
    "createdAt"   timestamptz NOT NULL DEFAULT now(),
    "servedAt"    timestamptz,
    "servedCount" integer NOT NULL DEFAULT 0,
    CONSTRAINT "FK_push_envelope_push_token" FOREIGN KEY ("userId", "deviceId")
        REFERENCES "push_token" ("userId", "deviceId") ON DELETE CASCADE
);

-- Every read and every sweep is scoped by the device; the cap orders by age.
CREATE INDEX IF NOT EXISTS "IDX_push_envelope_device"
    ON "push_envelope" ("userId", "deviceId", "createdAt");
