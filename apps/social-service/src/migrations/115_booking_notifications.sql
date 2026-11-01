-- Migration 115: the bookings REMINDER (WP-N of docs/wiki/bookings-chantier.md, decision D53, with
-- Q-R1 and Q-R6 as taken on 2026-10-27).
--
-- 1. `booking_spaces."reminderMinutes"`: the space's DEFAULT delay before a slot at which its people
--    are reminded; NULL = no reminder (Q-R1: "no reminder" is allowed). Every space, the existing
--    ones included, starts at 60 minutes: D53 decided the reminder exists, and the organiser changes
--    or removes it in the settings.
--
-- 2. On `bookings` (the HOLDER) and on `booking_participants` (each PARTICIPANT), one person each:
--    - "reminderMinutes": THIS person's delay, copied from the space's default when the row is
--      written and changed by the person alone afterwards (Q-R1); NULL = no reminder. A booking
--      written before this migration has NULL: nobody is reminded of it.
--    - "reminderSetAt": when that delay was last chosen. A reminder whose instant ("startsAt" minus
--      the delay) was already past when the delay was chosen is never sent (Q-R6: a booking made
--      inside its reminder delay gets none) - the rule reads this column, never a clock alone.
--    - "reminderSentAt": THE CLAIM. Stamped by a conditional UPDATE before the reminder is sent, so
--      two replicas of the service cannot both send it (forms-reminder.scheduler.ts's reasoning).
--      It answers ONE question, "was this person reminded", and nothing else reads it.
--
-- 3. A partial index per table on the due scan, so the minute's cron reads only the rows still owed.
--
-- No personal data is added: three numbers and two instants per person, deleted with the row (the
-- account erasure already deletes or tombstones both rows, BOOKINGS_ERASURE_STATEMENTS).
--
-- ROLLBACK: an image older than this migration ignores the columns; nothing it writes breaks them.
-- Idempotent for CD: IF NOT EXISTS, and each CHECK guarded by a catalogue check on this schema.

SET lock_timeout = '5s';

ALTER TABLE booking_spaces ADD COLUMN IF NOT EXISTS "reminderMinutes" integer NULL DEFAULT 60;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS "reminderMinutes" integer NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS "reminderSetAt" timestamptz NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS "reminderSentAt" timestamptz NULL;

ALTER TABLE booking_participants ADD COLUMN IF NOT EXISTS "reminderMinutes" integer NULL;
ALTER TABLE booking_participants ADD COLUMN IF NOT EXISTS "reminderSetAt" timestamptz NULL;
ALTER TABLE booking_participants ADD COLUMN IF NOT EXISTS "reminderSentAt" timestamptz NULL;

DO $$
DECLARE
  ns oid := to_regnamespace(current_schema())::oid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_spaces_reminder_range' AND connamespace = ns
  ) THEN
    ALTER TABLE booking_spaces ADD CONSTRAINT booking_spaces_reminder_range
      CHECK ("reminderMinutes" IS NULL OR "reminderMinutes" BETWEEN 5 AND 10080);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_reminder_range' AND connamespace = ns
  ) THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_reminder_range
      CHECK ("reminderMinutes" IS NULL OR "reminderMinutes" BETWEEN 5 AND 10080);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'booking_participants_reminder_range' AND connamespace = ns
  ) THEN
    ALTER TABLE booking_participants ADD CONSTRAINT booking_participants_reminder_range
      CHECK ("reminderMinutes" IS NULL OR "reminderMinutes" BETWEEN 5 AND 10080);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS bookings_reminder_due_idx ON bookings ("startsAt")
  WHERE "reminderSentAt" IS NULL AND "reminderMinutes" IS NOT NULL AND "cancelledAt" IS NULL;

CREATE INDEX IF NOT EXISTS booking_participants_reminder_due_idx ON booking_participants ("bookingId")
  WHERE "reminderSentAt" IS NULL AND "reminderMinutes" IS NOT NULL AND "withdrawnAt" IS NULL;
