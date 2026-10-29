-- Migration 041: dm_revoked_device_groups, the key groups a revoked device held (2026-10-27).
--
-- A revocation purges the device's rows (`purgeDeviceFootprint`), and in a key group - which has no
-- seats - those rows were the only thing binding its owner to the group, so the revoked-leaves
-- question could no longer be answered about that leaf. The purge now writes one row per key group
-- the device held, in the same transaction, and the question's binding reads it. A row ends with the
-- group and with the account.
-- Mechanism: docs/wiki/protocols/mls-protocol.md ("A revoked device's leaf is removed").
--
-- Additive: a new table, empty at creation, forward-only. Idempotent: IF NOT EXISTS (synchronize
-- creates it in dev; this is for prod).
--
-- LOCK TIMEOUT: nothing here locks an existing table, but the rule is uniform - a migration gives up
-- after five seconds rather than queue behind a long transaction, and a re-run is safe.
SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS dm_revoked_device_groups (
    "groupId"    UUID NOT NULL,
    "userId"     VARCHAR(255) NOT NULL,
    "deviceId"   VARCHAR(255) NOT NULL,
    "recordedAt" TIMESTAMP NOT NULL DEFAULT now(),
    PRIMARY KEY ("groupId", "userId", "deviceId")
);

CREATE INDEX IF NOT EXISTS "IDX_dm_revoked_device_groups_group_user"
    ON dm_revoked_device_groups ("groupId", "userId");

COMMIT;
