-- Migration 120: Lydia refunds from Canari (enrolment chantier lot 4, docs/wiki/frontend/modules/payments.md
-- "Refunds from Canari").
--
-- (1) `lydia_refunds`: ONE ROW PER REFUND ASKED, written `pending` BEFORE Lydia's `transaction/refund`
--     is called, so the durable state - never a clock - says a refund may be in flight. It is the
--     audit too: who asked (`requestedByUserId`), when (`requestedAt`, the database clock), how much
--     (`amountCents`, total or partial `kind`), for which payment (`purchaseRecordId`), why (`reason`,
--     the manager's text) and what Lydia answered (`outcome`: `refunded`, the refusal's typed
--     code, `no-answer`, `not-sent`, `refunded-unrecorded` (Lydia confirmed, Canari failed to record
--     it), or a manager's declaration after checking Lydia; NULL while the call runs). `lateOutcome`:
--     Lydia's answer when it arrived after the refund was already settled, kept beside it. `status`:
--     pending -> confirmed | refused. `sideEffect` says what a confirmed TOTAL refund withdrew.
--     `resolvedByUserId` / `resolvedAt`: the manager who settled a refund Lydia never confirmed.
--     `vendorToken` / `orderRef`: the Business and the transaction the refund was sent to, snapshotted.
--     UNIQUE per (payment, client idempotency key): a resent click is the same refund, never a second.
--     AT MOST ONE `pending` per payment (partial unique index): an unconfirmed refund blocks the next
--     until a manager settles it, so a payment is never refunded twice on a guess.
--     Personal data: manager account ids and a free-text reason; the payer is reached through the
--     purchase record. Art. 30 register entry C24, privacy policy changed in the same pull request.
--     Retention: as long as the purchase record it refunds (never deleted; anonymised at erasure).
-- (2) `purchase_records."submissionId"`: the form answer a form payment's record was written for, so a
--     form payment can be traced to its Lydia request. NULL on every row before this migration and on
--     boutique rows (traced through `product_checkouts."purchaseRecordId"`): no backfill.
-- (3) `submissions."lydiaOrderRef"` / `"lydiaVendorToken"`: the order_ref and the Business of the
--     CURRENT Lydia request of an online answer, written when the request is issued. A form order_ref
--     carries a random part (`form-order-ref.ts`) nothing kept before, so an answer paid before this
--     migration cannot be refunded from Canari. NULL on every older row: no backfill.
--
-- ADDITIVE AND REVERSIBLE: one new table, three NULL-able columns, indexes; nothing rewritten or
-- deleted. To reverse: DROP TABLE lydia_refunds; ALTER TABLE ... DROP COLUMN for the three columns.
-- ROLLBACK: an image older than this migration reads none of these. What a refund already did
-- SURVIVES a schema rollback and an image rollback: a purchase record set `refunded` stays so (an
-- older image does not know that status, so its purchases list stops showing the record), a freed
-- seat stays `refunded`, a revoked tier stays revoked. Dropping the table loses the refund history
-- and the order_refs, never the money: Lydia's own statement still holds every refund.
-- 120: 118 is the highest on main at the time of writing; 119 is left to lot 3 (the cashiers),
-- built in parallel.
-- Idempotent for CD: IF NOT EXISTS everywhere.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS lydia_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "purchaseRecordId" uuid NOT NULL,
  "associationId" uuid NOT NULL,
  "vendorToken" varchar(256) NOT NULL,
  "orderRef" varchar(128) NOT NULL,
  kind varchar(8) NOT NULL CHECK (kind IN ('total', 'partial')),
  "amountCents" integer NOT NULL CHECK ("amountCents" > 0),
  reason varchar(500) NOT NULL,
  "idempotencyKey" uuid NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'refused')),
  "outcome" varchar(64) NULL,
  "lateOutcome" varchar(64) NULL,
  "sideEffect" varchar(64) NULL,
  "requestedByUserId" varchar(255) NOT NULL,
  "requestedAt" timestamptz NOT NULL DEFAULT now(),
  "answeredAt" timestamptz NULL,
  "resolvedByUserId" varchar(255) NULL,
  "resolvedAt" timestamptz NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS lydia_refunds_one_per_key
  ON lydia_refunds ("purchaseRecordId", "idempotencyKey");

CREATE UNIQUE INDEX IF NOT EXISTS lydia_refunds_one_pending
  ON lydia_refunds ("purchaseRecordId") WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS lydia_refunds_association ON lydia_refunds ("associationId");

ALTER TABLE purchase_records ADD COLUMN IF NOT EXISTS "submissionId" uuid NULL;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "lydiaOrderRef" varchar(64) NULL;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "lydiaVendorToken" varchar(256) NULL;
