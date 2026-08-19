-- The churn insurance of migration 013, extended to the 96% of the table it never reached.
--
-- Migration 013 set a fixed small scale factor on `queued_message` because a queue table can grow
-- thirty-fold in an hour, and the default factor of 0.2 raises the vacuum threshold with the table -
-- so it waits longest exactly when the table is largest. That reasoning is right, and it was applied
-- to the wrong relation.
--
-- `ALTER TABLE ... SET (autovacuum_*)` does NOT reach a table's TOAST relation. A TOAST table carries
-- its own storage parameters, spelled with a `toast.` prefix on the parent, and inherits nothing.
-- Measured on prod 2026-08-19: `queued_message` is 73 MB, of which the heap is 2.5 MB, the indexes
-- 296 kB and `pg_toast_16615` **70 MB** - and its `reloptions` were empty. Every queued MLS payload
-- is a base64 blob well past the 2 kB toast threshold, so essentially all of the data this table
-- churns lives in the relation 013 left on the defaults it was written to replace.
--
-- Autovacuum is in fact keeping up on both (142 runs on the TOAST table, 4 dead tuples at the time
-- of writing), which is exactly the standing this migration wants: insurance is written while the
-- thing is healthy, not after. It changes nothing about the 70 MB already on disk - no VACUUM short
-- of FULL returns a file to the OS, and that 70 MB is the high-water mark of the 28 124-row incident
-- of 2026-08-10, kept for reuse rather than leaked.
--
-- Analyze options are deliberately absent: Postgres rejects `toast.autovacuum_analyze_*`, because a
-- TOAST table is never planned against and so is never analysed.
--
-- Idempotent, like 013: `ALTER TABLE ... SET` re-runs harmlessly, and the guard covers a fresh host
-- where TypeORM has not created the table yet.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'queued_message') THEN
    ALTER TABLE queued_message SET (
      toast.autovacuum_vacuum_scale_factor = 0.05,
      toast.autovacuum_vacuum_threshold = 200
    );
  END IF;
END $$;
