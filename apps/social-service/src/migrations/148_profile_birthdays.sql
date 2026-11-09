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
--    - "dateSetAt": when the DATE was last set (a visibility edit leaves it). A date takes effect
--      from the NEXT Paris day: the ring and the notice need it set before today (decision of the
--      lead, 2026-11-09 - a date moved onto today is never celebrated today).
--    - "lastAnnouncedOn": the Paris date the followers were last told. It IS the notice's claim: the
--      notifier's conditional UPDATE sets it in the transaction that writes the followers' bell rows,
--      and refuses while it is within 300 days - so a re-run, a second replica or a restart announces
--      nothing twice, and a moved date announces nothing twice in a year. Deleted with the row.
-- 2. `birthday_changes`: never a date of birth, two facts that outlive a clear on purpose:
--    - "changedAt": when a date was last set. A NEW date is accepted at most once per 30 days, a
--      clear then a set counting as a change (a correction the same Paris day keeps the window).
--      The notifier's hourly job empties it once the 30 days pass.
--    - "noticeOpensOn": written by a clear that follows an announcement, `lastAnnouncedOn + 300`,
--      and nothing else: no new date is announced or ringed before it, so a clear then a set
--      cannot buy a notice the 300 days would refuse. Emptied by the same job once it passes.
--    The row is deleted once both are empty, and by the account erasure.
--
-- The index serves the celebrants' read, `celebratedOnSql` comparing (month, day) as smallints.
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
  "dateSetAt" timestamptz NOT NULL DEFAULT now(),
  "lastAnnouncedOn" date,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "CHK_profile_birthdays_calendar" CHECK (
    day <= CASE WHEN month = 2 THEN 29 WHEN month IN (4, 6, 9, 11) THEN 30 ELSE 31 END
  )
);

CREATE INDEX IF NOT EXISTS "IDX_profile_birthdays_month_day" ON profile_birthdays (month, day);

CREATE TABLE IF NOT EXISTS birthday_changes (
  "userId" varchar(255) PRIMARY KEY,
  "changedAt" timestamptz,
  "noticeOpensOn" date
);

COMMIT;
