-- Migration 036: dm_seat_evictions, the durable record that a person was cut off a group's seats
-- (2026-10-22, the follow-up of WP-KEYGROUP-JOIN-GATE).
--
-- A seat that an accepted commit, a commit's admit or a key group's publisher creates is decided by
-- a check made before the group's seat lock (the roster, or social-service's entitlement over HTTP).
-- The writer reads this row before that check and writes the seat under the lock only if no
-- eviction has rewritten the row since. "owedDeparture" names a key group's departure in progress
-- (the generation of the eviction that began it); the eviction after social-service's roster write
-- settles it, and the hourly drain asks social-service for the outcome of one left behind.
-- Mechanism: docs/wiki/protocols/channel-encryption.md.
--
-- Additive: a new table, empty at creation - no data rewrite, and an absent row reads as "never
-- evicted". Idempotent: IF NOT EXISTS (synchronize creates the table in dev; this is for prod).
--
-- LOCK TIMEOUT: the same rule as 035 - a migration gives up rather than queue behind a long
-- transaction and stall everything queued behind its lock request; the deploy then fails loudly
-- and a re-run is safe (idempotent above).
SET lock_timeout = '5s';

BEGIN;

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
