-- Migration 058: whether a queued row's delivery step RAN (2026-11-25;
-- docs/wiki/protocols/mls-protocol.md, "The same Welcome stored twice is delivered once").
--
-- A Welcome is re-sent with the same bytes whenever its sender did not read the answer (the owed
-- Welcome is durable client state), and the re-send finds the row still queued. It used to hand that
-- row to the live publish again, because the first request "may have died between its store and its
-- delivery" - but the row could not say whether that first delivery had run, was running, or had
-- died. So a re-send arriving while (or after) the first request published it published it AGAIN:
-- prod 1.7.3, 2026-11-24, one Welcome row arrived live twice on a new web device, 160 ms apart.
--
-- `deliveryRan`: set by the transaction that publishes the row (`claimQueuedDelivery`,
-- `utils/queued-delivery-claim.ts`), which takes the row lock, publishes, and commits. A second
-- delivery waits on that lock and then finds it true, and publishes nothing; a delivery whose process
-- died rolled back with its connection, and the next re-send finds it false and delivers. No clock.
-- Only a Welcome's delivery claims it today; every other row keeps false and is never read for it.
--
-- ADDITIVE ONLY: a column with a constant default is a catalogue change, no rewrite, no backfill -
-- every existing row reads false, "no delivery recorded", which is exactly what the old release
-- knew about it. A release that predates it never reads it, so a rollback is safe.
--
-- LOCK TIMEOUT: ADD COLUMN takes ACCESS EXCLUSIVE on `queued_message`, the table every send writes
-- and every pull reads. The migration gives up after five seconds rather than queue behind a long
-- transaction; the deploy then fails loudly and a re-run is safe (idempotent). Asserted by
-- `migrations.lock-timeout.spec.ts`.
SET lock_timeout = '5s';

ALTER TABLE queued_message
    ADD COLUMN IF NOT EXISTS "deliveryRan" BOOLEAN NOT NULL DEFAULT false;
