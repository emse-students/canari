-- Migration 169: the Lydia Business that took a payment, on the purchase record itself
-- (owner, 2026-11-14; docs/wiki/lydia-contract-flux.md).
--
-- Until now the Business of a payment was read through the row that issued it: a boutique purchase's
-- paid attempt (`product_checkouts."vendorToken"`), a form payment's answer
-- (`submissions."lydiaVendorToken"`). A form answer can be deleted by its form's manager, so the
-- payment lost its Business and the platform's Lydia flux counted it nowhere. The record is the one
-- row a payment keeps for good (no foreign key reaches it: the deletion of an answer, a product, a
-- form - soft - or an association leaves it), so the Business is written there, at the settlement,
-- by the same transaction that writes the record.
--
-- `"lydiaVendorToken"`: NULL for a cash or manual sale, and for a payment no row ties to a Business
-- (a form answer before migration 120, a boutique purchase before 101). A live identifier, like
-- `associations."lydiaAccountId"`: never answered to a browser (the entity maps it `select: false`)
-- and cleared by a copy of production (`copy-strips.sh`).
--
-- THE BACKFILL copies, for every online record that has none yet, the token its paid attempt or its
-- answer names - exactly the trace the flux read before. Additive: one nullable column, filled where
-- it was NULL; nothing else is changed.
--
-- ROLLBACK: an older image never reads or writes the column; a record it writes meanwhile carries
-- NULL, and the flux still reads that record's trace (`measureLydiaFlux`). Idempotent for CD.

SET lock_timeout = '5s';

ALTER TABLE purchase_records ADD COLUMN IF NOT EXISTS "lydiaVendorToken" varchar(256) NULL;

UPDATE purchase_records r
   SET "lydiaVendorToken" = c.token
  FROM (SELECT "purchaseRecordId", MIN("vendorToken") AS token
          FROM product_checkouts
         WHERE status = 'paid' AND "purchaseRecordId" IS NOT NULL
         GROUP BY "purchaseRecordId") c
 WHERE c."purchaseRecordId" = r.id
   AND r.source = 'product'
   AND r."paymentMethod" = 'online'
   AND r."lydiaVendorToken" IS NULL;

UPDATE purchase_records r
   SET "lydiaVendorToken" = s."lydiaVendorToken"
  FROM submissions s
 WHERE s.id = r."submissionId"
   AND r.source = 'form'
   AND r."paymentMethod" = 'online'
   AND s."lydiaVendorToken" IS NOT NULL
   AND r."lydiaVendorToken" IS NULL;
