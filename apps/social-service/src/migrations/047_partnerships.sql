-- Migration 047: association partnerships (partner discount cards + their claimable codes).
-- Brand-new tables get an explicit CREATE TABLE here rather than relying on TypeORM
-- `synchronize` - see migration 016's note: synchronize was only ever safe for tables that
-- predate the migration system, not for tables introduced going forward. Idempotent for CD.

BEGIN;

CREATE TABLE IF NOT EXISTS partnership_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "associationId" uuid NOT NULL,
  title varchar(200) NOT NULL,
  description text,
  link varchar(500),
  "claimMode" varchar(20) NOT NULL,
  "sharedCode" varchar(200),
  "staticText" varchar(500),
  "membersOnly" boolean NOT NULL DEFAULT false,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partnership_cards_association ON partnership_cards ("associationId");

CREATE TABLE IF NOT EXISTS partnership_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "cardId" uuid NOT NULL REFERENCES partnership_cards(id) ON DELETE CASCADE,
  code varchar(200) NOT NULL,
  "claimedByUserId" uuid,
  "claimedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partnership_codes_card ON partnership_codes ("cardId");

-- No duplicate pasted codes for the same card.
CREATE UNIQUE INDEX IF NOT EXISTS idx_partnership_codes_card_code
  ON partnership_codes ("cardId", code);

-- At most one claimed code per (card, claimant) - the constraint the claim algorithm relies on
-- to make re-claiming idempotent under concurrent requests (see PartnershipsService.claimCard).
CREATE UNIQUE INDEX IF NOT EXISTS idx_partnership_codes_card_claimant
  ON partnership_codes ("cardId", "claimedByUserId") WHERE "claimedByUserId" IS NOT NULL;

COMMIT;
