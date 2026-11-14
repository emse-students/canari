-- Migration 024: the platform's Lydia contract terms, entered by a global admin
-- (docs/wiki/lydia-contract-flux.md).
--
--   lydia_contract_anniversary  the date the contract years start on, year after year. Seeded below
--                               with the date the owner gave on 2026-11-14; editable at
--                               /admin/platform.
--   lydia_contract              everything else, as one JSON object validated by core-service
--                               (`parseLydiaContractTerms`): the flux target, the VAT rate, the fee
--                               per payment kind (HT, as the contract states it) and the
--                               regularization bands. NULL until an admin enters them: the counter and
--                               the payout estimate then say "not configured".
--
-- NO CONTRACT VALUE IS WRITTEN HERE: the repository is public and the contract is confidential. Only
-- the anniversary date is seeded, the one value the owner put in a code default.
--
-- READ BY core-service only (`LydiaContractService`): the admin counter and the fee schedule a price
-- editor's estimate asks for. Never published by `GET /api/version`.
--
-- ADDITIVE ONLY: two nullable columns and the seed of the first on the singleton row. A release that
-- predates them never reads them, so a rollback is safe. Idempotent: the deploy ledger replays a file
-- whose predecessor failed mid-run, and the seed writes only a NULL.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS lydia_contract_anniversary DATE NULL;

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS lydia_contract JSONB NULL;

UPDATE platform_config
   SET lydia_contract_anniversary = DATE '2026-11-10'
 WHERE id = 1 AND lydia_contract_anniversary IS NULL;
