-- Migration 101: product_checkouts - ONE row per boutique checkout ATTEMPT (docs/wiki/frontend/modules/payments.md,
-- "A product checkout is a row, one per attempt").
--
-- WHY IT EXISTS (measured on dev, sandbox, 2026-10-21). A product checkout sent Lydia the order_ref
-- `product:<productId>:<userId>`, the SAME string every time, and Lydia refuses a second request/do
-- carrying an order_ref it has seen (error 3, "order_ref deja utilise"). So after one declined or
-- expired attempt a product could never be bought again, and nothing on Canari's side held the
-- request a purchase was waiting on: a return or a callback could be tied to nothing but the
-- order_ref's own fields. Now every attempt is a row, its id is the attempt id inside the order_ref
-- (`product:<productId>:<checkoutId>`, core-service lydia-order-ref.ts), and a purchase is settled
-- FROM the row - product, buyer and amount are the row's, never the callback's or the return
-- query's. An attempt whose issuing call never answered its request ids is read at Lydia by that
-- order_ref, so "requestUuid"/"requestId" may stay NULL on an open row.
--
-- "status": open (request issued or being issued) -> paid | declined (Lydia state 5) | expired |
-- cancelled (Lydia state 6, before or after "expiresAt"; cancelled also when no request was ever
-- issued). Only `paid` counts as a purchase; a closed row allows a retry. A `paid` answer is
-- recorded even over a closed row: the money was taken, and the row is Lydia's word, not ours.
--
-- AT MOST ONE OPEN ATTEMPT PER (product, buyer): `product_checkouts_one_open`, a partial UNIQUE
-- index, is what makes a double click issue ONE request - the second insert loses with 23505 and
-- is answered a typed 409. A retry first settles the open attempt at Lydia (cancel, or read it).
--
-- No foreign key to association_products: a product deleted while an attempt is open must not
-- lose the record of money taken for it, so the row carries its own "productName" snapshot.
--
-- A DELETED ACCOUNT (`account-erasure.ts`): the row is an accounting record and is anonymised,
-- per row ('[deleted]:' || id), because the partial unique index would collide on a constant.
-- User ids are varchar(255): a 64-char hex digest, never a uuid.
--
-- 101: 100 (`100_association_lydia_business_key.sql`, #1940) is the highest on main at the rebase
-- of 2026-10-21; 086 and 095 are gaps left by earlier work, not free numbers to reuse out of order.
--
-- Additive: one new table and its indexes, nothing altered or dropped. Idempotent for CD.

CREATE TABLE IF NOT EXISTS product_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" uuid NOT NULL,
  "userId" varchar(255) NOT NULL,
  "associationId" uuid NOT NULL,
  "paymentAssociationId" uuid NOT NULL,
  "amountCents" integer NOT NULL,
  currency varchar(3) NOT NULL DEFAULT 'eur',
  "productName" varchar(200) NOT NULL,
  "requestUuid" varchar(64) NULL,
  "requestId" varchar(32) NULL,
  status varchar(16) NOT NULL DEFAULT 'open',
  "expiresAt" timestamptz NOT NULL,
  "settledAt" timestamptz NULL,
  "purchaseRecordId" uuid NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_checkouts_request_uuid ON product_checkouts ("requestUuid");
CREATE INDEX IF NOT EXISTS product_checkouts_request_id ON product_checkouts ("requestId");
CREATE INDEX IF NOT EXISTS product_checkouts_product_user_status
  ON product_checkouts ("productId", "userId", status);
CREATE UNIQUE INDEX IF NOT EXISTS product_checkouts_one_open
  ON product_checkouts ("productId", "userId") WHERE status = 'open';

DO $$
DECLARE
  ns oid := to_regnamespace(current_schema())::oid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_checkouts_status' AND connamespace = ns) THEN
    ALTER TABLE product_checkouts ADD CONSTRAINT product_checkouts_status
      CHECK (status IN ('open', 'paid', 'declined', 'expired', 'cancelled'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_checkouts_amount' AND connamespace = ns) THEN
    ALTER TABLE product_checkouts ADD CONSTRAINT product_checkouts_amount CHECK ("amountCents" >= 0);
  END IF;
END $$;
