-- Migration 104: a paying guest's RECEIPT, stored as its hash.
--
-- See docs/wiki/public-paid-forms-chantier.md (WP-P2) and apps/social-service/src/forms/guest-receipt.ts.
--
-- A guest who pays on a public form comes back from Lydia with no session, so the return page
-- cannot be authorised the way a member's is. `submit` hands the guest a random 256-bit receipt in
-- the return URL and keeps only its SHA-256 here; the public receipt route finds the answer by that
-- hash and by nothing else - never by a submission id.
--
-- Schema only: a new NULLABLE column and a partial unique index. No row is changed, nothing is
-- backfilled, nothing is dropped. Every existing row keeps NULL (no guest has paid before WP-P1).
--
-- Idempotent for CD: both statements are IF NOT EXISTS.

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "guestReceiptHash" varchar(64);

CREATE UNIQUE INDEX IF NOT EXISTS submissions_guest_receipt_hash_uniq
  ON submissions ("guestReceiptHash")
  WHERE "guestReceiptHash" IS NOT NULL;
