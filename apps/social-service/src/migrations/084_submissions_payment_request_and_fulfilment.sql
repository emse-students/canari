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
-- Read-only counts of what the data half rewrites (run BEFORE applying):
--   SELECT COUNT(*) FROM submissions;
--   SELECT COUNT(*) FROM submissions WHERE "paymentStatus" = 'paid';
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
