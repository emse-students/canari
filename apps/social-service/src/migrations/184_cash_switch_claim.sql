-- Migration 184: a switch to cash in progress is a durable CLAIM on the answer, so no database lock
-- is held across the call to Lydia (review of #4019; docs/wiki/frontend/modules/forms.md, "A failed
-- card payment is settled in person instead").
--
-- WHAT IT ADDS. One nullable column on `submissions`, schema only:
--   "cashSwitchClaimId" - the token of the "Payer en direct" press that claimed a `pending` answer
--                          still within its hold, written in a short row-locked transaction BEFORE
--                          the switch cancels its request at Lydia, cleared by every outcome of the
--                          switch. While set, the release paths (Lydia's cancel callback, the return
--                          poll, the reconciliation) leave the row and a resume or a submit's retry
--                          refuses it, so the cancel cannot cost the payer the seat. A claim a crash
--                          leaves ends with the row's hold: the expiry job expires the row and
--                          clears it. NULL on every other row.
--
-- NO BACKFILL: no row is being switched before this image runs.
--
-- ROLLBACK. Nothing reads the column but this feature; an older image ignores it.
--   ALTER TABLE submissions DROP COLUMN IF EXISTS "cashSwitchClaimId";
--
-- LOCKS. ACCESS EXCLUSIVE on `submissions` for a catalogue change alone (a nullable column with no
-- default: no rewrite).
--
-- IDEMPOTENT: `ADD COLUMN IF NOT EXISTS`.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS "cashSwitchClaimId" uuid NULL;

COMMIT;
