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
-- THE BACKFILL (why this file is HELD): every Business linked before this migration. By the owner's
-- decision of 2026-10-23 a Business reaches an association only through the enrolment, the bridge's
-- historical account being the one exception, so the backfill takes the active `lydiaAccountId` of
-- every association EXCEPT a bridge's historical account, plus every bridge's enrolled Business.
-- It is right ONLY IF every association still collecting through a historical account has its
-- bridge row open when it runs - a historical account linked with no bridge row would be counted.
-- The approver checks that first (the query is in the wiki page above), then approves the checksum.
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
   AND NOT EXISTS (
     SELECT 1 FROM lydia_account_bridges b WHERE b."historicalVendorToken" = a."lydiaAccountId"
   )
ON CONFLICT ("vendorToken") DO NOTHING;

INSERT INTO lydia_enrolled_businesses ("vendorToken", "associationId", source)
SELECT b."enrolledVendorToken", b."associationId", 'backfill'
  FROM lydia_account_bridges b
 WHERE b."enrolledVendorToken" IS NOT NULL
ON CONFLICT ("vendorToken") DO NOTHING;
