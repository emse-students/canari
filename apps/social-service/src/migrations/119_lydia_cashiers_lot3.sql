-- Migration 119: Lydia enrolment lot 3 - cashiers who are not the Responsable, and removing one.
--
-- ADDITIVE ONLY: two columns of a timestamp and two of a sealed number, and one index. No row is
-- rewritten or deleted here.
--
-- (1) `lydia_cashiers."revokeUnconfirmedAt"`: set when Canari asked Lydia to remove the cashier's
--     CURRENT number and Lydia's own read of that number still showed a right (or could not be
--     read). The row stays live - Lydia may still list that person - and the screen says "retrait
--     non confirmé". Cleared by a later removal Lydia confirms (which closes the row).
-- (2) `lydia_cashiers."previousPhoneSealed"` / `"previousPhoneEnd"`: the Responsable's OLD number
--     during a number change, kept until Lydia confirms its removal. Sealed like `phoneSealed`
--     (`secret-box.ts`, purpose `lydia-cashier-phone/v1`, the association id as context); its last
--     two digits are the only part any read returns. Personal data: register entry C23. Cleared
--     with the row's own phone whenever the row is closed, and as soon as the old number's removal
--     is confirmed. While set, a SECOND number change is refused (`LYDIA_RESPONSABLE_PHONE_LOCKED`).
-- (3) `previousRevokeUnconfirmedAt`: the same flag as (1), for the old number.
-- (4) `lydia_cashiers_one_live_member`: one live row per member of an association, so two
--     concurrent adds of the same person cannot both be recorded.
--
-- ROLLBACK (reversible): `DROP INDEX lydia_cashiers_one_live_member;` then drop the four columns.
-- An image older than this migration reads none of them; nothing it writes breaks them.
-- Idempotent for CD: IF NOT EXISTS everywhere.

SET lock_timeout = '5s';

ALTER TABLE lydia_cashiers ADD COLUMN IF NOT EXISTS "revokeUnconfirmedAt" timestamptz NULL;
ALTER TABLE lydia_cashiers ADD COLUMN IF NOT EXISTS "previousPhoneSealed" text NULL;
ALTER TABLE lydia_cashiers ADD COLUMN IF NOT EXISTS "previousPhoneEnd" varchar(2) NULL;
ALTER TABLE lydia_cashiers ADD COLUMN IF NOT EXISTS "previousRevokeUnconfirmedAt" timestamptz NULL;

CREATE UNIQUE INDEX IF NOT EXISTS lydia_cashiers_one_live_member
  ON lydia_cashiers ("associationId", "userId")
  WHERE "removedAt" IS NULL;
