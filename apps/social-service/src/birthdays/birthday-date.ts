import { BadRequestException } from '@nestjs/common';

/**
 * A BIRTHDAY IS A DAY AND A MONTH, AND WHICH CALENDAR DATE CELEBRATES IT (owner, 2026-11-08).
 *
 * The year is never asked (decision 1), so nothing here can compute an age. "Today" is the PARIS
 * calendar date read from the DATABASE's clock, as the engagement daily cap reads its day
 * (docs/wiki/engagement.md, L6): one clock for every replica, whatever zone a container runs in.
 *
 * 29 FEBRUARY is a birthday like any other: entered, stored and shown as the 29th, and CELEBRATED -
 * the ring, the profile's line, the followers' notice - on 28 February of a year that has no 29th,
 * so a member born that day is celebrated every year rather than one in four. Pinned against
 * PostgreSQL in `birthdays.integration.spec.ts` (2027, a common year; 2028, a leap year).
 */

/** A birthday as stored: month 1..12, day 1..31 held to the month. */
export interface BirthdayDate {
  month: number;
  day: number;
}

/** The typed refusal code of a day and month no calendar has. */
export const BIRTHDAY_DATE_INVALID = 'BIRTHDAY_DATE_INVALID';

/** The longest each month can be, February counting its 29th - index 0 is January. */
const MONTH_LENGTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Whether (month, day) is a date some year has - the same rule as the table's CHECK constraints. */
export function isBirthdayDate(month: unknown, day: unknown): boolean {
  return (
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    (month as number) >= 1 &&
    (month as number) <= 12 &&
    (day as number) >= 1 &&
    (day as number) <= MONTH_LENGTH[(month as number) - 1]
  );
}

/** Narrows an untrusted (month, day) to a {@link BirthdayDate}, or throws a 400 typed {@link BIRTHDAY_DATE_INVALID}. */
export function parseBirthdayDate(month: unknown, day: unknown): BirthdayDate {
  if (isBirthdayDate(month, day)) return { month: month as number, day: day as number };
  throw new BadRequestException({
    code: BIRTHDAY_DATE_INVALID,
    message: 'month must be 1..12 and day a day of that month',
  });
}

/** The time zone the school lives in: the day a birthday is celebrated on, and its morning. */
export const BIRTHDAY_TIME_ZONE = 'Europe/Paris';

/** SQL: today's Paris calendar date, on the database's clock. */
export const PARIS_TODAY_SQL = `(now() AT TIME ZONE '${BIRTHDAY_TIME_ZONE}')::date`;

/** SQL: the current hour (0..23) in Paris, on the database's clock. */
export const PARIS_HOUR_SQL = `EXTRACT(HOUR FROM now() AT TIME ZONE '${BIRTHDAY_TIME_ZONE}')::int`;

/**
 * SQL condition: a birthday stored as (`month`, `day`) is celebrated on the date expression `date`.
 * Its own day; and a 29 February on the 28th of a year whose February has no 29th (`make_date(y, 3,
 * 1) - 1` is the last day of that February).
 *
 * Each branch compares the COLUMNS to `smallint` expressions of `date` alone, so the
 * `(month, day)` index can serve either branch (a `numeric` from a bare `EXTRACT` would cast the
 * column instead and rule the index out). At a few hundred rows the planner may still prefer a scan.
 */
export function celebratedOnSql(month: string, day: string, date: string): string {
  return `((${month} = EXTRACT(MONTH FROM ${date})::smallint
      AND ${day} = EXTRACT(DAY FROM ${date})::smallint)
    OR (${month} = 2::smallint AND ${day} = 29::smallint
      AND EXTRACT(MONTH FROM ${date}) = 2 AND EXTRACT(DAY FROM ${date}) = 28
      AND EXTRACT(DAY FROM make_date(EXTRACT(YEAR FROM ${date})::int, 3, 1) - 1) = 28))`;
}

/**
 * SQL condition: birthday row `b`'s date is IN EFFECT on the Paris date `date` - it was set before
 * that day began. A date set or moved today is celebrated from its next occurrence, never today:
 * moving it onto today cannot buy a ring or a notice (lead decision, 2026-11-09, docs/wiki/birthdays.md).
 */
export function dateInEffectSql(b: string, date: string): string {
  return `(${b}."dateSetAt" AT TIME ZONE '${BIRTHDAY_TIME_ZONE}')::date < ${date}`;
}

/** At most one notice per member in this many days, whatever the date is moved to. */
export const BIRTHDAY_NOTICE_EVERY_DAYS = 300;

/** A date may be changed at most once in this many days; a clear then a set counts as a change. */
export const BIRTHDAY_CHANGE_WINDOW_DAYS = 30;

/**
 * SQL condition: birthday row `b` may be announced on the Paris date `date` - never announced, or
 * last announced at least {@link BIRTHDAY_NOTICE_EVERY_DAYS} days before, and not before the
 * `noticeOpensOn` a clear kept (`birthday_changes`: a clear then a set buys nothing). The claim.
 */
export function noticeOpenSql(b: string, date: string): string {
  return `((${b}."lastAnnouncedOn" IS NULL
      OR ${b}."lastAnnouncedOn" <= ${date} - ${BIRTHDAY_NOTICE_EVERY_DAYS})
    AND NOT EXISTS (SELECT 1 FROM birthday_changes notice_gate
      WHERE notice_gate."userId" = ${b}."userId" AND notice_gate."noticeOpensOn" > ${date}))`;
}

/**
 * SQL condition: birthday row `b` is CELEBRATED on the Paris date `date` - the ring and the
 * profile's line: its day ({@link celebratedOnSql}), set before that day ({@link dateInEffectSql}),
 * and that day's notice was sent or may be ({@link noticeOpenSql}). The ring follows the notice's
 * eligibility, so a date moved within the 300 days moves no ring either.
 */
export function celebratedTodaySql(b: string, date: string): string {
  return `(${celebratedOnSql(`${b}.month`, `${b}.day`, date)}
    AND ${dateInEffectSql(b, date)}
    AND (${b}."lastAnnouncedOn" = ${date} OR ${noticeOpenSql(b, date)}))`;
}
