-- Migration 103: a purchase record may name NO buyer - a GUEST's payment on a public form.
--
-- See docs/wiki/public-paid-forms-chantier.md (WP-P1) and docs/wiki/frontend/modules/forms.md.
--
-- A public form is answered without an account, and since WP-P1 it may charge (decision PP1): the
-- guest pays through Lydia with an e-mail Canari never stores (PP2), and the submission row carries
-- `"userId"` NULL. What that payment buys includes the association's accounting trace, the
-- `purchase_records` row `FormsService.fulfilPayment` writes - which had `"userId"` NOT NULL, so the
-- record of a guest's money would fail to insert and the treasurer's export would miss it.
--
-- Schema only: no row is changed, nothing is backfilled, nothing is dropped. Every existing row
-- keeps its buyer. Readers of the column already tolerate a missing name (the accounting list
-- names a NULL buyer "Invite", the per-user history filters by an account id).
--
-- Idempotent for CD: dropping a NOT NULL that is already gone is a no-op.

ALTER TABLE purchase_records ALTER COLUMN "userId" DROP NOT NULL;
