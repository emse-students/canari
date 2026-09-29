-- Migration 027: every MLS signature key a device has published, kept for ever.
--
-- See docs/wiki/protocols/channel-encryption.md section 21. A Graine v2 seed is endorsed with its
-- minter's device signature key, and a member verifies a RELAYED seed against that key after the
-- minter's device may have left the tree. `key_package` holds one row per device and replaces it on
-- every re-registration, so it forgets the key a seed was endorsed with; this table never does.
--
-- Written from each KeyPackage a device uploads (register-device and register-device/prekeys),
-- whose credential identity must name the uploader. No backfill, and none is needed: the route that
-- serves this history also reads the key out of the device's CURRENT `key_package` row, so a device
-- that has uploaded nothing since this table appeared is still answered for.
--
-- Idempotent: CREATE TABLE / INDEX IF NOT EXISTS (synchronize creates them in dev; this is for prod).

CREATE TABLE IF NOT EXISTS device_signature_key (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "userId"        VARCHAR(255) NOT NULL,
    "deviceId"      VARCHAR(255) NOT NULL,
    "signatureKey"  VARCHAR(44) NOT NULL,
    "firstSeenAt"   TIMESTAMP NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "UQ_device_signature_key"
    ON device_signature_key ("userId", "deviceId", "signatureKey");

CREATE INDEX IF NOT EXISTS "IDX_device_signature_key_user"
    ON device_signature_key ("userId");
