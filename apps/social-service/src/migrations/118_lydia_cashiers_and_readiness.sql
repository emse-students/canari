-- Migration 118: Lydia enrolment lot 2 - the Responsable, the readiness cause, the enrolment marker.
--
-- (1) `lydia_cashiers`: the people Canari added as cashiers of an association's Lydia Business.
--     Lot 2 writes the Responsable only ('responsable'); 'tresorier' and 'vendeur' are lot 3's.
--     The phone is SEALED at rest (`secret-box.ts`, purpose `lydia-cashier-phone/v1`, the
--     association id as context) and never stored in clear; `phoneEnd` (its last two digits) is the
--     ONLY phone data any read returns. A row is `confirmedAt` once Lydia's own read-back showed
--     every right. Personal data: an account id and a phone number - Art. 30 register entry C23
--     and the privacy policy changed in the same pull request. Retention: while the person is a
--     cashier; the sealed phone AND `phoneEnd` are cleared when `removedAt` is set (hence `phoneEnd`
--     NULL-able), while the closed row keeps `userId` / `addedByUserId` - who was a cashier of which
--     Business, and who added them - until the account's erasure (`account-erasure.ts` deletes the
--     person's rows and anonymises them as `addedByUserId`).
-- (2) `associations."lydiaReadinessCause"` / `"lydiaReadinessAt"`: why and when
--     `lydiaOnboardingComplete` last changed ('webhook-validated', 'admin', 'request-refused',
--     'request-blocked'). NULL on every row before this migration: no backfill.
-- (3) `associations."lydiaEnrolmentStartedAt"`: the durable "enrolment in flight" marker, set
--     atomically BEFORE `business/create` (only WHERE it is NULL and no Business is linked) and
--     cleared by the link or by a typed refusal. An UNCONFIRMED create leaves it set, so a second
--     Business cannot be created until a global admin clears it.
-- (4) `associations."lydiaResponsableStartedAt"`: the same marker for the Responsable step, claimed
--     atomically before `business/addcashier` so two managers cannot both have Lydia add a cashier;
--     cleared by the record, by a typed refusal, by the unlink, or by a global admin.
--
-- ROLLBACK: an image older than this migration reads none of these; nothing it writes breaks them.
-- Idempotent for CD: IF NOT EXISTS everywhere.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS lydia_cashiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "associationId" uuid NOT NULL REFERENCES associations(id) ON DELETE CASCADE,
  "vendorToken" varchar(256) NOT NULL,
  "userId" varchar NOT NULL,
  "phoneSealed" text NULL,
  "phoneEnd" varchar(2) NULL,
  role varchar(16) NOT NULL DEFAULT 'responsable'
    CHECK (role IN ('responsable', 'tresorier', 'vendeur')),
  "addedByUserId" varchar NOT NULL,
  "addedAt" timestamptz NOT NULL DEFAULT now(),
  "confirmedAt" timestamptz NULL,
  "removedAt" timestamptz NULL
);

-- One live Responsable per association.
CREATE UNIQUE INDEX IF NOT EXISTS lydia_cashiers_one_responsable
  ON lydia_cashiers ("associationId")
  WHERE role = 'responsable' AND "removedAt" IS NULL;

-- The erasure and "is this person a cashier" reads.
CREATE INDEX IF NOT EXISTS lydia_cashiers_user ON lydia_cashiers ("userId");

ALTER TABLE associations ADD COLUMN IF NOT EXISTS "lydiaReadinessCause" varchar(32) NULL;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "lydiaReadinessAt" timestamptz NULL;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "lydiaEnrolmentStartedAt" timestamptz NULL;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "lydiaResponsableStartedAt" timestamptz NULL;
