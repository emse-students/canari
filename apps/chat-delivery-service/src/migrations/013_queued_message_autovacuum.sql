-- Per-table autovacuum settings for queued_message.
--
-- NOT a fix for the 70 MB incident of 2026-08-10: autovacuum was measured keeping up (78 runs,
-- 234 dead tuples against 1173 live at the time of writing). That table grew because one
-- abandoned device accumulated 28 124 undelivered rows over five hours, which is a delivery
-- problem, and it is answered by the hourly queue-depth report, not by vacuum.
--
-- This is insurance for the CHURN PROFILE instead. Every row is inserted, delivered and deleted,
-- and the table can grow thirty-fold in a few hours; the default scale factor of 0.2 means the
-- vacuum threshold rises with the table, so it waits longest exactly when the table is largest.
-- A fixed small factor keeps the dead-tuple ceiling proportional to a healthy size rather than to
-- the worst moment.
--
-- Idempotent: ALTER TABLE ... SET re-runs harmlessly, and IF EXISTS covers a fresh host where
-- TypeORM has not created the table yet.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'queued_message') THEN
    ALTER TABLE queued_message SET (
      autovacuum_vacuum_scale_factor = 0.05,
      autovacuum_vacuum_threshold = 200,
      autovacuum_analyze_scale_factor = 0.05,
      autovacuum_analyze_threshold = 200
    );
  END IF;
END $$;
