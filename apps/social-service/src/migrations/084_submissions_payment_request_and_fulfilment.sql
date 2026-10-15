-- Migration 084 : submissions - when the CURRENT payment request was issued, and two durable
-- fulfilment flags (forms.md, "An online payment holds its seat for 30 minutes").
--
-- "paymentRequestedAt": the seat hold of an online `pending` answer is counted from it, not from
--   "createdAt", because `submit` reuses a live pending row and issues a NEW payment request: the
--   hold must restart with that request. Written by the database's own now() (DEFAULT, and
--   `() => 'now()'` on reuse), same clock and same type as "createdAt".
-- "cotisationGrantedAt" / "purchaseRecordedAt": set when `markPaid` (or the cash validation) has
--   granted the cotisation / written the purchase record, or found there was nothing to do. A
--   replayed payment re-runs only what is still NULL: idempotence from the row, never a clock.
--
-- DATA half (needs the user's yes before a production deploy): existing rows get
-- "paymentRequestedAt" = "createdAt" (their only request), and every row already `paid` has both
-- flags set to "updatedAt", because the code before this migration ran both effects on every
-- `markPaid` - leaving them NULL would make the next replay grant and record a second time.
-- Read-only counts of what the data half rewrites, each one line, copyable as is, run BEFORE
-- applying (the columns do not exist yet, so no count can name them):
--   -- 1. rows whose "paymentRequestedAt" is backfilled from "createdAt" (every row):
--   SELECT COUNT(*) AS backfilled_request_time FROM submissions;
--   -- 2. rows that get both fulfilment flags set (already paid, so already fulfilled once):
--   SELECT COUNT(*) AS flagged_as_fulfilled FROM submissions WHERE "paymentStatus" = 'paid';
--   -- 3. the same, split by method (cash validation and online markPaid both fulfilled):
--   SELECT COALESCE("paymentMethod", 'online') AS method, COUNT(*) FROM submissions WHERE "paymentStatus" = 'paid' GROUP BY 1 ORDER BY 1;
--   -- 4. what the expiry job will move to `expired` on its first run after the deploy:
--   SELECT COUNT(*) AS first_expiry_run FROM submissions WHERE "paymentStatus" = 'pending' AND "createdAt" <= now() - make_interval(secs => 1800);
--   -- 5. the whole status population, for the before/after comparison:
--   SELECT "paymentStatus", COUNT(*) FROM submissions GROUP BY 1 ORDER BY 1;
--
-- Idempotent: IF NOT EXISTS, and every UPDATE only fills a NULL.

BEGIN;

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "paymentRequestedAt" timestamp;
UPDATE submissions SET "paymentRequestedAt" = "createdAt" WHERE "paymentRequestedAt" IS NULL;
ALTER TABLE submissions ALTER COLUMN "paymentRequestedAt" SET DEFAULT now();
ALTER TABLE submissions ALTER COLUMN "paymentRequestedAt" SET NOT NULL;

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "cotisationGrantedAt" timestamptz;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "purchaseRecordedAt" timestamptz;
UPDATE submissions
SET "cotisationGrantedAt" = COALESCE("cotisationGrantedAt", "updatedAt"),
    "purchaseRecordedAt" = COALESCE("purchaseRecordedAt", "updatedAt")
WHERE "paymentStatus" = 'paid'
  AND ("cotisationGrantedAt" IS NULL OR "purchaseRecordedAt" IS NULL);

COMMIT;
