-- WHEN A PUBLISHED KEY PACKAGE STOPS BEING USABLE, WRITTEN BY THE CLIENT THAT MINTED IT.
--
-- The expiry lives inside the serialized MLS KeyPackage, and the only thing in this estate that can
-- parse one is the client's WASM crate: these two tables store an opaque base64 string, so no query
-- has ever been able to tell an elapsed package from a fresh one. The consequences were all live on
-- production on 2026-09-16:
--
--   * `resolveKeyPackagePayloadForDevice` served a device's static last-resort package 48 hours past
--     its `not_after`. The joiner refused it - `LifetimeError(Expired)` - the invitation was neither
--     satisfied nor abandoned, and it retried on every launch for ever. Two accounts were in that
--     state at the moment of the count, and 4 last-resort rows were aged.
--   * The pool is served `ORDER BY "createdAt" ASC`, nearest-to-expiry first, and the row is DELETED
--     as it is handed out - so an attempt that fails on an expired package still consumes it. 171
--     aged one-time rows sat on 5 devices, every one of them at the front of its own queue.
--   * `getPrekeyCount` counted expired rows as available, and that count is what decides how many
--     packages the client mints next. 30 650 rows over 654 devices, none of it filtered.
--
-- THE BACKFILL IS SOUND FOR ONE TABLE AND NOT THE OTHER, WHICH IS WHY THEY DIFFER BELOW.
--
-- openmls sets `not_after = mint + 84 days`, so `createdAt + 84 days` reconstructs it exactly for a
-- row written at publication time. `one_time_key_package` rows are INSERTED once and DELETED as they
-- are served - nothing ever updates one - so `createdAt` really is the mint instant and the whole
-- table can be filled in.
--
-- `key_package` cannot be, and assuming otherwise would certify expired packages as valid. The
-- static row is UPDATED in place on every re-registration and `registerDevice` resets `createdAt`
-- deliberately (a device re-enrolling after 30 days would otherwise drop off the device list's
-- cutoff), while the client REPUBLISHES the last-resort package it already holds rather than minting
-- a new one. A row can therefore carry today's date and a package that elapses in four days. It stays
-- NULL - honestly unknown - until an updated client reports it, and a NULL is read as "not known to
-- be expired" so no existing device is locked out by a fact nobody has.
--
-- Both columns are `timestamptz` against a `createdAt` that is `timestamp` - the database runs in
-- UTC and TypeORM writes UTC, but the conversion is spelled out rather than left to a session
-- setting.

ALTER TABLE one_time_key_package
  ADD COLUMN IF NOT EXISTS "notAfter" timestamptz;

UPDATE one_time_key_package
  SET "notAfter" = ("createdAt" AT TIME ZONE 'UTC') + interval '84 days'
  WHERE "notAfter" IS NULL;

ALTER TABLE key_package
  ADD COLUMN IF NOT EXISTS "notAfter" timestamptz;

-- The resolver pops the pool for one device ordered by expiry, and the reclaim scans the whole
-- table by expiry alone.
CREATE INDEX IF NOT EXISTS "IDX_otkp_device_not_after"
  ON one_time_key_package ("userId", "deviceId", "notAfter");

CREATE INDEX IF NOT EXISTS "IDX_otkp_not_after"
  ON one_time_key_package ("notAfter");
