-- Migration 036: dm_seat_evictions, the durable record that a person was cut off a group's seats
-- (2026-10-22, the follow-up of WP-KEYGROUP-JOIN-GATE).
--
-- A seat that an accepted commit or a key group's publisher creates is decided by a check made
-- before the group's seat lock (the roster, or social-service's entitlement over HTTP). The writer
-- reads this row before that check and writes the seat under the lock only if no eviction has
-- rewritten the row since. `owed` marks a key group's departure whose post-roster eviction has not
-- arrived; the hourly drain settles it. Mechanism: docs/wiki/protocols/channel-encryption.md.
--
-- Additive: a new table, empty at creation - no data rewrite, and an absent row reads as "never
-- evicted". Idempotent: IF NOT EXISTS (synchronize creates the table in dev; this is for prod).

BEGIN;

CREATE TABLE IF NOT EXISTS dm_seat_evictions (
    "groupId"    UUID NOT NULL,
    "userId"     VARCHAR(255) NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "owed"       BOOLEAN NOT NULL DEFAULT FALSE,
    "updatedAt"  TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY ("groupId", "userId")
);

CREATE INDEX IF NOT EXISTS "IDX_dm_seat_evictions_owed"
    ON dm_seat_evictions ("owed");

COMMIT;
