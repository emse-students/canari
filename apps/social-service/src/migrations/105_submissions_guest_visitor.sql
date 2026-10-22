-- Migration 105: who is WAITING on a guest's paid answer, for the per-visitor ceiling.
--
-- See docs/wiki/public-paid-forms-chantier.md (WP-P3, decision PP5) and
-- apps/social-service/src/forms/guest-visitor.ts.
--
-- A public form takes any number of answers from one link, and a paid one holds a seat while it
-- waits for its payment. The ceiling of three waiting answers per visitor is counted from the ROWS,
-- so each guest's paid answer carries a keyed hash (HMAC-SHA256 under the service's internal
-- secret) of the form id and the visitor's address - never the address. It is set only while the
-- answer waits (`pending`, `pending_cash`) and cleared by the expiry job once it does not.
--
-- Schema only: a new NULLABLE column and a partial index. No row is changed, nothing is
-- backfilled, nothing is dropped.
--
-- Idempotent for CD: both statements are IF NOT EXISTS.

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "guestVisitorKey" varchar(64);

CREATE INDEX IF NOT EXISTS submissions_guest_visitor_idx
  ON submissions ("formId", "guestVisitorKey")
  WHERE "guestVisitorKey" IS NOT NULL;
