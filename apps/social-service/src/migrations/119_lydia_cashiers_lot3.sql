-- Migration 119: Lydia enrolment lot 3 - cashiers who are not the Responsable, and removing one.
--
-- ADDITIVE ONLY: five nullable columns and one index. No row is rewritten or deleted here.
--
-- (1) `lydia_cashiers."revokeUnconfirmedAt"`: set when Canari asked Lydia to remove the cashier's
--     CURRENT number and Lydia's own read of that number still showed a right (or could not be
--     read). The row stays live - Lydia may still list that person - and the screen says "retrait
--     non confirmé". Cleared by a later removal Lydia confirms (which closes the row), and by a role
--     change (the number holds the new role's rights again).
-- (2) `lydia_cashiers."previousPhoneSealed"` / `"previousPhoneEnd"`: the Responsable's OTHER number
--     during a number change - the old one once the new one is confirmed, kept until Lydia confirms
--     its removal; or the new one while Lydia has not confirmed it (the old one then stays the live
--     number, with every right). Sealed like `phoneSealed` (`secret-box.ts`, purpose
--     `lydia-cashier-phone/v1`, the association id as context); its last two digits are the only
--     part any read returns. Personal data: register entry C23. Cleared with the row's own phone
--     whenever the row is closed, and as soon as that number's removal is confirmed. While set, only
--     THAT number may be switched to; a third one is refused (`LYDIA_RESPONSABLE_PHONE_LOCKED`).
-- (3) `previousRevokeUnconfirmedAt`: the same flag as (1), for the other number.
-- (4) `lydia_cashiers_one_live_member`: one live row per member of an association, so two
--     concurrent adds of the same person cannot both be recorded.
-- (5) `associations."lydiaCashierClaimToken"`: a random token written with the cashier claim
--     (`"lydiaResponsableStartedAt"`, migration 118). Only a release or a record carrying it clears
--     the claim, so a late caller can never clear a claim another operation has taken since.
--
-- ROLLBACK: reversible, BUT dropping (1)-(3) LOSES DATA while any of them is set (a number Lydia
-- may still list, or a removal it did not confirm). Run the guard first: it refuses (RAISE) unless
-- none is set, and only then drop.
--
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM lydia_cashiers
--                 WHERE "previousPhoneSealed" IS NOT NULL OR "revokeUnconfirmedAt" IS NOT NULL
--                    OR "previousRevokeUnconfirmedAt" IS NOT NULL) THEN
--       RAISE EXCEPTION 'migration 119 rollback refused: a cashier row still tracks another number or an unconfirmed removal';
--     END IF;
--   END $$;
--   DROP INDEX lydia_cashiers_one_live_member;
--   ALTER TABLE lydia_cashiers DROP COLUMN "revokeUnconfirmedAt", DROP COLUMN "previousPhoneSealed",
--     DROP COLUMN "previousPhoneEnd", DROP COLUMN "previousRevokeUnconfirmedAt";
--   ALTER TABLE associations DROP COLUMN "lydiaCashierClaimToken";
--
-- An image older than this migration reads none of them; nothing it writes breaks them.
-- Idempotent for CD: IF NOT EXISTS everywhere.

SET lock_timeout = '5s';

ALTER TABLE lydia_cashiers ADD COLUMN IF NOT EXISTS "revokeUnconfirmedAt" timestamptz NULL;
ALTER TABLE lydia_cashiers ADD COLUMN IF NOT EXISTS "previousPhoneSealed" text NULL;
ALTER TABLE lydia_cashiers ADD COLUMN IF NOT EXISTS "previousPhoneEnd" varchar(2) NULL;
ALTER TABLE lydia_cashiers ADD COLUMN IF NOT EXISTS "previousRevokeUnconfirmedAt" timestamptz NULL;
ALTER TABLE associations ADD COLUMN IF NOT EXISTS "lydiaCashierClaimToken" uuid NULL;

CREATE UNIQUE INDEX IF NOT EXISTS lydia_cashiers_one_live_member
  ON lydia_cashiers ("associationId", "userId")
  WHERE "removedAt" IS NULL;
