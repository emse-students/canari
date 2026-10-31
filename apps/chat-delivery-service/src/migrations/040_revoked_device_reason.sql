-- Migration 040: a ban on a device id records WHO banned it (2026-10-25).
--
-- `revoked_device` is written by one route, `DELETE /mls/devices/:userId/:deviceId`, for two
-- different facts: the OWNER revoking a device from another of their devices (the holder must wipe
-- and sign out), and an install RETIRING the id its own identity rotation abandoned (a later holder
-- of that id may enrol again under a fresh one). Registration answers them with two refusal codes
-- (`DEVICE_REVOKED_BY_OWNER`, `DEVICE_REVOKED` + `reason: 'retired'`), so the row must say which.
--
--   revoked_device."reason" - 'owner' | 'retired'; NULL on every row written before this migration.
--
-- NO BACKFILL, deliberately: nothing recorded who wrote an older row, so a value written here would
-- assert a fact nobody knows. The reader (`revocationReasonOf`) reads NULL as 'owner' - the reading
-- that wipes a device rather than letting a possibly-revoked one back in.
--
-- Additive and idempotent: a nullable column with no default rewrites no row, and ADD COLUMN IF NOT
-- EXISTS replays as a no-op.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `revoked_device`, which every device
-- registration and every commit reads. Waiting behind a long transaction would stall them behind the
-- queued lock request, so the migration gives up instead; the deploy then fails loudly and a re-run
-- is safe. Asserted by `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

ALTER TABLE "revoked_device"
    ADD COLUMN IF NOT EXISTS "reason" VARCHAR(16) NULL;
