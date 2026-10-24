-- Migration 034: a key-group frame is stored ONCE, not once per seat (backlog, P2 "Graine rotates on
-- every key-group epoch", item 3).
--
-- Measured on production 2026-10-21: one key-group payload sat in 31 `queued_message` rows on average,
-- and the key groups held 883 MB of a 1.5 GB queue. The per-device row stays the DELIVERY RECORD (its
-- id is what a device ACKs, what a push names, what the pull pages over); on a key-group fan-out it
-- now points at one `queued_payload` row instead of carrying the ciphertext itself.
-- Design: docs/wiki/services/chat-delivery.md ("A key-group frame is stored once").
--
-- ADDITIVE, NO BACKFILL. Every existing row keeps its inline `proto` and `payloadId` reads NULL, which
-- is exactly the shape every reader already serves; nothing is rewritten, so the old rows are correct
-- without touching them and leave the queue through ACK or the 90-day retention as before.
--
-- No foreign key, like every other column joining this service's tables: a payload is deleted only
-- when no record references it (`collectUnreferencedPayloads`, hourly) or with its group
-- (`deleteGroupOwnedRows`, records first, same transaction).
--
-- Idempotent: CREATE ... IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, and an index left INVALID by an
-- interrupted build is dropped before it is built again (synchronize builds all of it in development;
-- this is for the two estates).
--
-- THE READERS SHIP BEFORE THE WRITER. This migration and the release carrying it only READ shared
-- payloads; the writer stays off behind `QUEUED_PAYLOAD_SHARED_WRITES` (`infrastructure/deploy/
-- env-manifest.tsv`, `false`) until a LATER release turns it on. A record pointing at a payload has a
-- NULL `proto`, and an image older than the readers would serve it as an empty frame that the device
-- ACKs away - so the writer must never run while a rollback could land on such an image.
--
-- LOCK TIMEOUT: `ADD COLUMN` takes ACCESS EXCLUSIVE on `queued_message`, the busiest table of the
-- service. Waiting behind a long transaction would stall every send queued behind the lock, so the
-- migration gives up instead; the deploy then fails loudly and a re-run is safe (idempotent above).
-- Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS queued_payload (
    "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "groupId"   UUID NOT NULL,
    "proto"     TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "IDX_queued_payload_groupId" ON queued_payload ("groupId");

ALTER TABLE queued_message ADD COLUMN IF NOT EXISTS "payloadId" UUID NULL;

-- The collector's anti-join looks records up BY payload, and only a shared record has one: PARTIAL,
-- so the inline rows (every row today) cost the index nothing.
--
-- CONCURRENTLY, because a plain CREATE INDEX holds SHARE on `queued_message` for the whole build and
-- blocks every send. The runner allows it: `infrastructure/lib/migrations.sh` feeds the file to psql
-- on stdin with no `--single-transaction`, so each statement commits on its own.
--
-- A CONCURRENT BUILD THAT FAILS LEAVES AN INVALID INDEX BEHIND, under this very name - the lock
-- timeout above is one way to fail it. `IF NOT EXISTS` would then skip the build and keep an index
-- the planner never uses, so a leftover that is not valid is dropped first. A plain DROP INDEX, since
-- a DO block cannot run DROP INDEX CONCURRENTLY; it takes the table lock for an instant, under the
-- same lock timeout.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_index
        WHERE indexrelid = to_regclass('"IDX_queued_message_payloadId"') AND NOT indisvalid
    ) THEN
        RAISE NOTICE 'dropping the INVALID leftover of IDX_queued_message_payloadId';
        DROP INDEX "IDX_queued_message_payloadId";
    END IF;
END
$$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_queued_message_payloadId"
    ON queued_message ("payloadId") WHERE "payloadId" IS NOT NULL;

-- Same autovacuum shape as `queued_message` (migrations 013 and 017): a queue's rows are deleted as
-- fast as they are written, and the default scale factor lets the dead tuples and TOAST pile up.
ALTER TABLE queued_payload SET (
    autovacuum_vacuum_scale_factor = 0.05,
    autovacuum_vacuum_threshold = 200,
    autovacuum_analyze_scale_factor = 0.05,
    autovacuum_analyze_threshold = 200,
    toast.autovacuum_vacuum_scale_factor = 0.05,
    toast.autovacuum_vacuum_threshold = 200
);
