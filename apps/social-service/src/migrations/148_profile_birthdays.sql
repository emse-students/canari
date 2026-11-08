-- Migration 148 : birthdays on profiles (owner, 2026-11-08, engagement).
--
-- docs/wiki/backlog.d/birthdays-on-profiles.md and docs/wiki/birthdays.md. The owner's decisions:
-- (1) the DAY and the MONTH only - the year is never asked, so no age can be shown or computed;
-- (2) who sees the date outside the day is the member's choice - everyone at the school, their
--     followers, or nobody - FOLLOWERS by default;
-- (3) on the day a ring around the avatar is shown to everyone, whatever (2) says;
-- (4) on the morning of the day, the member's followers who may see the date are told.
--
-- 1. `profile_birthdays`: ONE row per member who entered a date, none for anybody else - the field
--    is optional and empty for every existing account, so there is nothing to backfill. The CHECKs
--    refuse a date no calendar has (31 April, 30 February); 29 February is a real birthday and is
--    celebrated on the 28th in a year without one (`birthdays/birthday-date.ts`). `visibility` is
--    the shared profile-field rule (`birthdays/profile-field-visibility.ts`). No foreign key on
--    "userId": `users` is core-service's table; the account erasure deletes the row.
-- 2. `birthday_notices`: the durable record that a member's birthday of ONE Paris calendar date was
--    announced. The notifier claims it (`INSERT ... ON CONFLICT DO NOTHING`) in the transaction that
--    writes the followers' notifications, so a re-run, a second replica or a restart within the day
--    announces nothing twice - idempotence from state, never from a clock.
--
-- The celebrants of a day are found by (month, day): a handful of rows a day out of a few hundred,
-- so the index is the whole read.
--
-- ADDITIVE: two new tables and an index, no existing row read or changed - not held. Idempotent for
-- CD: IF NOT EXISTS everywhere. LOCKS: none on an existing table; gives up after 5 s rather than queue.

SET lock_timeout = '5s';

BEGIN;

CREATE TABLE IF NOT EXISTS profile_birthdays (
  "userId" varchar(255) PRIMARY KEY,
  month smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  day smallint NOT NULL CHECK (day BETWEEN 1 AND 31),
  visibility varchar(16) NOT NULL DEFAULT 'followers'
    CHECK (visibility IN ('school', 'followers', 'nobody')),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CHK_profile_birthdays_calendar" CHECK (
    day <= CASE WHEN month = 2 THEN 29 WHEN month IN (4, 6, 9, 11) THEN 30 ELSE 31 END
  )
);

CREATE INDEX IF NOT EXISTS "IDX_profile_birthdays_month_day" ON profile_birthdays (month, day);

CREATE TABLE IF NOT EXISTS birthday_notices (
  "userId" varchar(255) NOT NULL,
  "celebratedOn" date NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "celebratedOn")
);

COMMIT;
