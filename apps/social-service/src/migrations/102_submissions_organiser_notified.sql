-- Migration 102 : submissions - "organiserNotifiedAt", the durable flag of the organiser alert for
-- a payment that landed on a FULL form (forms.md, "The organiser is told when a payment lands over
-- capacity").
--
-- "organiserNotifiedAt": set when `markPaid` has written the in-app notification telling the form's
-- managers that this row landed `paid_over_capacity` (a refund they owe). Claimed through
-- `claimFulfilment` like the two flags of migration 084: a conditional UPDATE only one caller wins,
-- released if writing the notification failed, so a replayed callback or a second settle notifies
-- AT MOST ONCE. Idempotence from the row, never a clock.
--
-- SCHEMA ONLY: NULL on every existing row, no backfill. A row already `paid_over_capacity` before
-- this migration is never revisited by a job; only a replay of ITS OWN payment confirmation reaches
-- `markPaid` again, and that replay would tell the organiser about a refund that is genuinely owed.
--
-- Idempotent: IF NOT EXISTS.

BEGIN;

ALTER TABLE submissions ADD COLUMN IF NOT EXISTS "organiserNotifiedAt" timestamptz;

COMMIT;
