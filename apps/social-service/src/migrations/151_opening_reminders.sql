-- Migration 151 : the opening reminders of forms, booking spaces and events, in ONE table
-- (engagement WP-4, decision 5d and L9).
--
-- docs/wiki/engagement.md, "(d) openings for followers - one notice, never two". The owner
-- (2026-11-07): the followers of an association are told AUTOMATICALLY when one of its forms,
-- booking spaces or events opens; "Me prévenir" stays for everyone else; each person gets ONE
-- notification, never two.
--
-- ONE ROW PER (kind, target, person) - the unique key IS the "never two": a follower who also
-- asked has one row, so one claim, so one push, whichever cause wrote the row first.
--
-- - `kind`: what opens - 'form', 'booking' (a booking space's window, `booking_spaces."opensAt"`)
--   or 'event' (an agenda event without a registration form, which opens when it is validated).
-- - `targetId`: the form, the booking space or the calendar event. No foreign key: one column names
--   three tables. A row naming a deleted target is claimed without a push by the scheduler, and
--   taken by the 30-day purge.
-- - `origin`: 'asked' (the person pressed "Me prévenir") or 'followed' (they follow the target's
--   association, written at publication). An ask on a follower's row turns it into 'asked'.
-- - `notified5min` / `notifiedOnOpen`: the two claims (the stamp IS the claim,
--   `FormReminderScheduler`). A follower's row is written with `notified5min` true: a follower gets
--   the opening, not the five-minute heads-up, unless they also ask.
--
-- `form_reminders` is NOT read by this file: copying it is a BACKFILL, so it is migration 152, HELD
-- for the approval (`-- canari:hold-for-owner`, "Which migrations are held").
--
-- ADDITIVE: a new table and its indexes, no existing row read or changed. Idempotent for CD: IF NOT
-- EXISTS. LOCKS: none on an existing table; the migration gives up after 5 s rather than queue.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS opening_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind varchar(16) NOT NULL CHECK (kind IN ('form', 'booking', 'event')),
  "targetId" uuid NOT NULL,
  "userId" varchar(255) NOT NULL,
  "opensAt" timestamptz NOT NULL,
  origin varchar(16) NOT NULL CHECK (origin IN ('asked', 'followed')),
  "notified5min" boolean NOT NULL DEFAULT false,
  "notifiedOnOpen" boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_opening_reminders_target_user" UNIQUE (kind, "targetId", "userId")
);

-- The scheduler's two reads, every minute: the rows not yet told of the opening, by instant.
CREATE INDEX IF NOT EXISTS "IDX_opening_reminders_due"
  ON opening_reminders ("opensAt") WHERE NOT "notifiedOnOpen";

-- The account erasure, and a person's own "Me prévenir" reads (which also use the unique key).
CREATE INDEX IF NOT EXISTS "IDX_opening_reminders_user" ON opening_reminders ("userId");

COMMIT;
