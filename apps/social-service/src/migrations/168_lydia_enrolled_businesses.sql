-- canari:hold-for-owner: the backfill below decides which existing Businesses count toward the platform's Lydia flux
--
-- Migration 168: which Lydia Businesses Canari's OWN enrolment created - the durable fact the
-- platform's Lydia flux counter reads (docs/wiki/lydia-contract-flux.md).
--
-- The platform's Lydia partnership counts the volume collected on the Businesses created by
-- Canari's enrolment (`business/create` under Canari's Provider), NEVER on a historical account an
-- association held before and still collects through on a bridge (migration 167): those payments
-- belong to the association's own earlier Lydia contract. A payment row already names the Business
-- that took it (`product_checkouts."vendorToken"`, `submissions."lydiaVendorToken"`), so the one fact
-- missing was whether THAT Business is a Canari-enrolled one. It was never written anywhere:
-- `associations."lydiaEnrolmentVendorToken"` is cleared by the link, and `lydiaAccountId` moves (a
-- bridge swaps it, an unlink clears it).
--
-- WRITTEN AT THE SOURCE from now on: `AssociationsService.setLydiaAccountId` - the ONE path that
-- links a Business, called only by core-service's onboarding right after `business/create` - inserts
-- the row in the transaction that links it (active or a bridge's pending Business alike). Never
-- deleted: an unlinked or switched-away Business stays enrolled, so the payments it took in a
-- contract year keep counting in that year.
--
-- THE BACKFILL (why this file is HELD): every Business linked before this migration that CARRIES
-- THE PROOF OF `business/create` - its dashboard URL. Lydia hands `dashboard_url` out only in
-- `business/create`'s answer (migration 063), the enrolment refuses to link a Business without one
-- (`business/create answered no dashboard_url`, enrolment lot 1), and a historical account put into
-- an association by hand carries none. A bridge's enrolled Business is taken too, and a bridge's
-- historical account never. NOT "every active lydiaAccountId except a bridge's historical account":
-- migration 167 ships with this one and its bridges are opened BY HAND afterwards, so at this
-- migration's run no bridge exists yet and every historical account still collecting would have been
-- counted (measured read-only 2026-11-14 on production: 5 linked associations, 2 of them historical
-- accounts, neither with a dashboard URL).
-- An allowlist, never a denylist: a Business left out is reported by the counter as `excluded`, and a
-- person who knows it was enrolled adds its row by hand; a historical account wrongly let in would
-- count silently.
-- The approver runs the check query in the wiki page above, then approves the checksum.
-- A Business enrolled and unlinked before this migration is not recovered: no table names it.
--
-- ROLLBACK: an older image never reads this table, and the rows it holds change no behaviour.
-- Idempotent for CD: IF NOT EXISTS and ON CONFLICT DO NOTHING.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS lydia_enrolled_businesses (
  "vendorToken" varchar(256) PRIMARY KEY,
  "associationId" uuid NULL REFERENCES associations(id) ON DELETE SET NULL,
  "enrolledAt" timestamptz NOT NULL DEFAULT now(),
  source varchar(16) NOT NULL DEFAULT 'enrolment' CHECK (source IN ('enrolment', 'backfill'))
);

INSERT INTO lydia_enrolled_businesses ("vendorToken", "associationId", source)
SELECT a."lydiaAccountId", a.id, 'backfill'
  FROM associations a
 WHERE a."lydiaAccountId" IS NOT NULL
   AND a."lydiaDashboardUrl" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM lydia_account_bridges b WHERE b."historicalVendorToken" = a."lydiaAccountId"
   )
ON CONFLICT ("vendorToken") DO NOTHING;

INSERT INTO lydia_enrolled_businesses ("vendorToken", "associationId", source)
SELECT b."enrolledVendorToken", b."associationId", 'backfill'
  FROM lydia_account_bridges b
 WHERE b."enrolledVendorToken" IS NOT NULL
ON CONFLICT ("vendorToken") DO NOTHING;
