-- Migration 036: automatic retry of failed Cercle top-up webhook deliveries.
--
-- `nextAttemptAt` is when the scheduler should try again; NULL on a failed row means the automatic
-- ladder is exhausted and a human has to act. `autoRetryCount` is kept apart from `attemptCount`
-- because the initial dispatch already burns three attempts - a shared counter would report the
-- automatic ladder as exhausted before it ever started.
--
-- Columns are double-quoted camelCase to match TypeORM's default naming (see migration 029).
-- Idempotent: ADD COLUMN IF NOT EXISTS is a no-op when the column already exists.

BEGIN;

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "autoRetryCount" INTEGER NOT NULL DEFAULT 0;

-- The scheduler's only query: due rows, oldest first.
CREATE INDEX IF NOT EXISTS "idx_webhook_deliveries_next_attempt"
  ON webhook_deliveries ("nextAttemptAt")
  WHERE "nextAttemptAt" IS NOT NULL;

-- Hands the failures that already exist to the new ladder, starting now. Narrowly conditioned so a
-- replay cannot resurrect a row whose automatic retries were later exhausted (that leaves
-- `autoRetryCount` above zero, which this excludes).
UPDATE webhook_deliveries
SET "nextAttemptAt" = now()
WHERE status = 'failed'
  AND "nextAttemptAt" IS NULL
  AND "autoRetryCount" = 0;

COMMIT;
