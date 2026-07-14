-- Migration 017: parent-association payment delegation. A "club" association with no Stripe
-- account of its own (or that simply prefers to) can route its online payments (paid forms +
-- boutique) to a PARENT association's Stripe Connect account, and grant that parent read access
-- to its Canari-side accounting. The link is proposed by the club and must be APPROVED by the
-- parent before any routing takes effect.
--
-- The `associations` table is created by TypeORM synchronize with the default naming strategy
-- (quoted camelCase columns, see migrations 008/016), so new columns are quoted to match.
-- All statements use IF NOT EXISTS so this script is idempotent.

BEGIN;

-- The parent association whose Stripe Connect account receives this association's payments.
-- Distinct from `parentAssociationId` (which denotes a promo list's owning BDE - organizational
-- ownership, not financial routing). Null when no delegation is requested.
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "paymentParentAssociationId" UUID;

-- Lifecycle of the delegation link: NULL (none), 'pending' (club requested, awaiting the parent's
-- approval), or 'approved' (parent accepted - routing + accounting access are live). A rejection
-- or cancellation clears both this and paymentParentAssociationId back to NULL.
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "paymentDelegationStatus" VARCHAR(20);

-- Look up a parent's delegated children (approval queue, accounting access checks) without a scan.
CREATE INDEX IF NOT EXISTS "idx_associations_payment_parent"
  ON associations ("paymentParentAssociationId");

COMMIT;
