-- Migration 063: persist the Lydia Business dashboard URL, since Lydia hands it out exactly once.
-- `business/create`'s response carries `dashboard_url` alongside `api_token` (the vendor_token we
-- already store as `lydiaAccountId`), but until now that URL was kept only in the frontend's
-- in-memory state for the duration of the creation request - a page reload lost it for good, and
-- `LydiaPaymentProvider.createConnectDashboardLink` throws precisely because Lydia has no
-- re-issuable login link like Stripe's Express dashboard. Storing what we were given once is the
-- only way to offer a persistent "open the dashboard" button. Nullable/defaulted so existing rows
-- (and every other provider) are unaffected. Idempotent via IF NOT EXISTS.

BEGIN;

ALTER TABLE associations ADD COLUMN IF NOT EXISTS "lydiaDashboardUrl" VARCHAR;

COMMIT;
