-- Migration 024: the platform's Lydia contract terms, entered by a global admin
-- (docs/wiki/lydia-contract-flux.md).
--
--   lydia_contract_anniversary  the date the contract years start on, year after year, entered at
--                               /admin/platform like every other term. NULL until then: the counter
--                               says "not configured".
--   lydia_contract              everything else, as one JSON object validated by core-service
--                               (`parseLydiaContractTerms`): the flux target, the VAT rate, the fee
--                               per payment kind (HT, as the contract states it) and the
--                               regularization bands. NULL until an admin enters them: the counter and
--                               the payout estimate then say "not configured".
--
-- NO CONTRACT VALUE IS WRITTEN HERE, the anniversary included: the repository is public and the
-- contract is confidential (owner, 2026-11-14).
--
-- READ BY core-service only (`LydiaContractService`): the admin counter and the fee schedule a price
-- editor's estimate asks for. Never published by `GET /api/version`.
--
-- ADDITIVE ONLY: two nullable columns. A release that predates them never reads them, so a rollback
-- is safe. Idempotent: the deploy ledger replays a file whose predecessor failed mid-run.

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS lydia_contract_anniversary DATE NULL;

ALTER TABLE platform_config
  ADD COLUMN IF NOT EXISTS lydia_contract JSONB NULL;
