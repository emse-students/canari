-- Migration 124: payment_delegation_acceptances - who accepted each payment delegation, and when
-- (owner, 2026-11-02; docs/wiki/frontend/modules/payments.md "Payment delegation").
--
-- A list collects only through a payment delegation to an association that ACCEPTS it, and only the
-- receiver's own shop managers (MANAGE_PRODUCTS on the receiver) or the platform administrator may
-- accept - never a BDE governing the receiver. Every acceptance is RECORDED here, by the same
-- transaction that writes `associations."paymentDelegationStatus" = 'approved'`
-- (`AssociationsService.approvePaymentDelegation`): one row per acceptance, append-only, never
-- updated, so a revoked and re-accepted delegation keeps both acceptances.
--
-- `acceptedAs`: `member` (the receiver's own MANAGE_PRODUCTS holder) or `platform-admin`.
-- `acceptedAt`: the database clock.
--
-- Personal data: the accepting manager's account id. Art. 30 register entry C8 (associations, cotisations, forms,
-- payments), kept as long as the delegation's accounting; anonymised at account erasure
-- (`account-erasure.ts`, `payment_delegation_acceptances_accepted_by`). No foreign key:
-- `users` is core-service's table, and an association's deletion keeps its accounting trail.
--
-- ADDITIVE: one new table, one index, no backfill (an acceptance made before this migration was
-- never recorded, and is not invented). An image older than this migration never reads the table.
--
-- Idempotent for CD: IF NOT EXISTS everywhere.
--
-- LOCKS: a new table locks nothing another statement holds; the timeout below is the house rule,
-- so a migration never queues writes behind an unexpected lock - it fails loudly and re-runs.
SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS payment_delegation_acceptances (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "childAssociationId"  uuid NOT NULL,
    "parentAssociationId" uuid NOT NULL,
    "acceptedByUserId"    varchar(255) NOT NULL,
    "acceptedAs"          varchar(20) NOT NULL
        CHECK ("acceptedAs" IN ('member', 'platform-admin')),
    "acceptedAt"          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "IDX_payment_delegation_acceptances_child"
    ON payment_delegation_acceptances ("childAssociationId", "acceptedAt");

COMMIT;
