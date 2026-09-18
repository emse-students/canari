-- THE BACKFILL DRAINED AND THEN REFILLED, BECAUSE NOTHING HELD THE INVARIANT AFTER IT RAN.
--
-- Migration 024 filled `one_time_key_package."notAfter"` for every row that predated it, on the
-- sound ground that this table is INSERT-once and never updated, so `createdAt + 84 days` is the
-- package's real lifetime. What it did not do was stop new NULLs arriving: a client older than
-- 2026-09-16 publishes prekeys as bare base64 with no date, the server stored the NULL, and the
-- resolver read it as "not known to be expired".
--
-- Measured on production on 2026-09-18, two days after 024: 577 undated rows, every single one of
-- them created on 2026-09-17 or 2026-09-18 - i.e. all of them written AFTER the backfill. The
-- population is not a shrinking tail of legacy rows, it is a steady inflow, and each row is one the
-- resolver cannot judge for the next 84 days.
--
-- So the same arithmetic 024 proved correct becomes the column's DEFAULT rather than a one-shot
-- UPDATE. A row that arrives with no date now gets the only date its table can honestly carry, at
-- the instant it is inserted, whatever client sent it and whatever code path stored it.
--
-- THE COLUMN STAYS NULLABLE ON PURPOSE. Making it NOT NULL would be the stronger statement, but an
-- old container writing an explicit NULL during the rollout window would then fail the insert
-- outright - a publish that 500s where today it merely stores a row nobody can judge. The DEFAULT
-- covers every insert that omits the column, and the two read sites COALESCE to the same bound for
-- an explicit NULL, so the filter is total without a constraint that can refuse a write.
--
-- `key_package` gets NONE of this and must not: that row is UPDATED in place on re-registration and
-- `registerDevice` resets `createdAt` while the client republishes a package it already holds, so
-- the same arithmetic there would certify an expired package as valid. The one-way inference that
-- IS sound for it lives in `lastResortDeadline`.

UPDATE one_time_key_package
  SET "notAfter" = ("createdAt" AT TIME ZONE 'UTC') + interval '84 days'
  WHERE "notAfter" IS NULL;

ALTER TABLE one_time_key_package
  ALTER COLUMN "notAfter" SET DEFAULT (now() + interval '84 days');
