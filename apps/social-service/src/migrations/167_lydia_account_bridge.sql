-- Migration 167: a historical Lydia account collects until the enrolled Business is validated
-- (owner, 2026-11-13) - a TEMPORARY bridge, removed once no association is left on one
-- (docs/wiki/legacy-compatibility.md).
--
-- See docs/wiki/frontend/modules/payments.md, "A historical account collects until the enrolled
-- Business is validated (owner, 2026-11-13)".
--
-- `associations."lydiaAccountId"` and its columns (key, dashboard URL, readiness) keep meaning ONE
-- thing everywhere: the ACTIVE collecting Business. A row here says the association is on a bridge,
-- and holds the OTHER Business, the one that does not collect now (the "standby"):
--
--   state = 'historical': the historical account (`historicalVendorToken`) is the active one, in the
--     association's columns; `enrolledVendorToken` is the Business Canari's enrolment created and
--     Lydia has not validated yet (NULL until the enrolment links it), its sealed key, dashboard URL
--     and readiness in the standby columns. It never collects.
--   state = 'switched': Lydia's BUSINESS_VALIDATED (or a global admin) switched the enrolled Business
--     into the association's columns; the historical account sits in the standby columns, its key
--     KEPT only to refund the payments its rows name and to verify their callbacks.
--
-- The standby key is sealed exactly like `associations."lydiaBusinessKeyCiphertext"` (purpose
-- `lydia-business-key/v1`, context `<associationId>:<vendorToken>`), so a switch moves a ciphertext
-- between the two places unchanged and it still opens.
--
-- Counters, for the population read: `switchCount` (switches to the enrolled Business),
-- `switchBackCount` (switches back after error 5 on it) and `reissueCount` (payments re-issued on
-- the historical account after such an error 5).
--
-- No backfill: an association with no row keeps exactly its behaviour. Rows are written by a person
-- (the bridge is opened by hand for an association holding a historical account) and by the switch.
--
-- ROLLBACK: an image older than this migration reads none of this. With no row it changes nothing.
-- With a row, the older image sees the association's columns only - the active Business - so
-- payments keep collecting on it; a VALIDATED naming the standby Business is a 200 that writes
-- nothing; a refund of a payment taken on the standby Business finds no key and is refused
-- (`LYDIA_REFUND_NO_KEY`, nothing sent to Lydia). Nothing it writes breaks this table.
-- Idempotent for CD: IF NOT EXISTS everywhere.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS lydia_account_bridges (
  "associationId" uuid PRIMARY KEY REFERENCES associations(id) ON DELETE CASCADE,
  "historicalVendorToken" varchar(256) NOT NULL,
  "enrolledVendorToken" varchar(256) NULL,
  state varchar(16) NOT NULL DEFAULT 'historical' CHECK (state IN ('historical', 'switched')),
  "standbyKeyCiphertext" text NULL,
  "standbyDashboardUrl" text NULL,
  "standbyReady" boolean NOT NULL DEFAULT false,
  "standbyReadinessCause" varchar(32) NULL,
  "standbyReadinessAt" timestamptz NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "switchedAt" timestamptz NULL,
  "switchCount" integer NOT NULL DEFAULT 0,
  "switchBackCount" integer NOT NULL DEFAULT 0,
  "reissueCount" integer NOT NULL DEFAULT 0,
  CONSTRAINT lydia_account_bridges_switched_names_enrolled
    CHECK (state = 'historical' OR "enrolledVendorToken" IS NOT NULL),
  CONSTRAINT lydia_account_bridges_two_businesses
    CHECK ("enrolledVendorToken" IS NULL OR "enrolledVendorToken" <> "historicalVendorToken")
);

-- A Business is one association's, and one role's.
CREATE UNIQUE INDEX IF NOT EXISTS lydia_account_bridges_historical
  ON lydia_account_bridges ("historicalVendorToken");
CREATE UNIQUE INDEX IF NOT EXISTS lydia_account_bridges_enrolled
  ON lydia_account_bridges ("enrolledVendorToken") WHERE "enrolledVendorToken" IS NOT NULL;
