-- Migration 036: a group's seat generation, and dm_seat_evictions, the record of a person's
-- key-group departure (2026-10-22, the follow-up of WP-KEYGROUP-JOIN-GATE).
--
-- A seat that an accepted commit, a commit's admit or a key group's publisher creates is decided by
-- a check made before the group's seat lock (the roster, or social-service's entitlement over HTTP).
-- The writer reads dm_groups."seatGeneration" before that check and writes the seat under the lock
-- only if no eviction in the group has moved it since. The generation is the GROUP's, so nothing
-- naming an account has to outlive an account erasure to refuse a claim taken before it.
-- dm_seat_evictions."owedDeparture" names a key group's departure in progress (the person's row
-- generation of the eviction that began it); the eviction after social-service's roster write
-- settles it, and the hourly drain asks social-service for the outcome of one left behind.
-- Mechanism: docs/wiki/protocols/channel-encryption.md.
--
-- Additive: a column with a constant default (no table rewrite) and a new table, empty at creation;
-- generation 0 and an absent row read as "never evicted". Idempotent: IF NOT EXISTS (synchronize
-- creates both in dev; this is for prod).
--
-- LOCK TIMEOUT: if a lock it needs is held by a long transaction, this migration gives up after five
-- seconds rather than wait - a waiting lock request would stall every query queued behind it. The
-- deploy then fails loudly, and a re-run is safe (idempotent above).
SET lock_timeout = '5s';

BEGIN;

ALTER TABLE dm_groups ADD COLUMN IF NOT EXISTS "seatGeneration" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS dm_seat_evictions (
    "groupId"       UUID NOT NULL,
    "userId"        VARCHAR(255) NOT NULL,
    "generation"    INTEGER NOT NULL DEFAULT 0,
    "owedDeparture" INTEGER NULL,
    "updatedAt"     TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY ("groupId", "userId")
);

CREATE INDEX IF NOT EXISTS "IDX_dm_seat_evictions_owed_departure"
    ON dm_seat_evictions ("owedDeparture")
    WHERE "owedDeparture" IS NOT NULL;

COMMIT;
