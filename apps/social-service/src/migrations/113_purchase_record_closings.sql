-- Migration 113: purchase_record_closings - how a payment marked `paid_not_granted` was CLOSED
-- (docs/wiki/cotisations.md, "Rising to a higher tier").
--
-- See apps/social-service/src/users/entities/purchase-record-closing.entity.ts.
--
-- A cotisation tier paid for and not granted is money taken for nothing yet: a refund or a grant by
-- hand is owed, and the hourly report says so at ERROR. Nothing recorded that it was done, so the
-- report could never return to zero. An association manager now records WHICH of the two happened,
-- from the association's purchases list: one row here, written once. The purchase record keeps its
-- `paid_not_granted` status as history; the report counts only the marked payments with NO row here.
-- No clock decides anything: a marked payment stays reported until a person records its outcome.
-- Decided by the user on 2026-10-27.
--
-- "outcome": `refunded` (the money went back, outside Canari) or `granted` (the tier was granted by
-- hand - the closing grants it, under the buyer's tier lock, in the same transaction as this row).
-- "closedByUserId": the manager who recorded it (a 64-char hex user id; anonymised by the account
-- erasure like every other authorship column). "createdAt": the SERVER's own clock, never a client's.
--
-- ONE ROW PER PURCHASE RECORD: `purchase_record_closings_one_per_record` is UNIQUE, so a payment is
-- closed once; a second close is refused with a typed 409. "purchaseRecordId" is a plain uuid with no
-- foreign key, like product_checkouts."purchaseRecordId" (101): purchase records are never deleted.
--
-- 113: 112 (`112_product_checkouts_held_tier.sql`) is the migration before it, in the same change.
--
-- Additive: one new table, nothing altered or dropped. Idempotent for CD: IF NOT EXISTS.
--
-- LOCK TIMEOUT: a new table locks nothing a request uses, but the rule is the same for every
-- migration from 108 on: give up after five seconds rather than queue, and re-run safely.
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS purchase_record_closings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "purchaseRecordId" uuid NOT NULL,
  outcome varchar(16) NOT NULL,
  "closedByUserId" varchar(255) NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_record_closings_outcome CHECK (outcome IN ('refunded', 'granted'))
);

CREATE UNIQUE INDEX IF NOT EXISTS purchase_record_closings_one_per_record
  ON purchase_record_closings ("purchaseRecordId");
