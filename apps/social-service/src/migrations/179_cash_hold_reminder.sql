-- Migration 179: the member is told ONCE before their cash hold expires (owner decision of
-- 2026-11-21, "launch now: payment resume"; docs/wiki/frontend/modules/forms.md, "A cash hold is
-- announced once before it expires").
--
-- WHAT IT ADDS. Two nullable columns on `submissions`, schema only for new rows:
--   "cashReminderDueAt"      - when the notice is owed, written by `submit` beside `cashExpiresAt`
--                              (`cash-reminder.ts`: the expiry minus the shorter of 24 hours and half
--                              the hold), so the hourly job compares one stored instant with now();
--   "cashReminderNotifiedAt" - the CLAIM: set by a conditional UPDATE exactly one run wins, cleared
--                              again if writing the notice failed. NULL = not told.
--
-- THE BACKFILL. A row already waiting for cash (`pending_cash` with an expiry) is owed its notice
-- 24 hours before that expiry - the rule's value for every hold of two days or more. A row whose
-- expiry is less than 24 hours away is told at the first hourly run after the deploy; one already
-- past is expired by that same run, never told. Rows that no longer wait stay NULL and are never
-- selected. Re-running it writes nothing new: it fills only a NULL due date.
--
-- ROLLBACK. Nothing reads the columns but this feature; an older image ignores them.
--   ALTER TABLE submissions DROP COLUMN IF EXISTS "cashReminderDueAt",
--     DROP COLUMN IF EXISTS "cashReminderNotifiedAt";
--
-- LOCKS. ACCESS EXCLUSIVE on `submissions` for a catalogue change alone (nullable columns, no
-- default: no rewrite), then row locks for the backfill of the few rows waiting for cash.
--
-- IDEMPOTENT: `ADD COLUMN IF NOT EXISTS`, and the backfill touches only a NULL due date.

SET lock_timeout = '5s';

BEGIN;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS "cashReminderDueAt" timestamptz NULL,
  ADD COLUMN IF NOT EXISTS "cashReminderNotifiedAt" timestamptz NULL;

UPDATE submissions
   SET "cashReminderDueAt" = "cashExpiresAt" - interval '24 hours'
 WHERE "paymentStatus" = 'pending_cash'
   AND "cashExpiresAt" IS NOT NULL
   AND "cashReminderDueAt" IS NULL;

COMMIT;
