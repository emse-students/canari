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
 */
export function celebratedOnSql(month: string, day: string, date: string): string {
  return `((${month} = EXTRACT(MONTH FROM ${date}) AND ${day} = EXTRACT(DAY FROM ${date}))
    OR (${month} = 2 AND ${day} = 29 AND EXTRACT(MONTH FROM ${date}) = 2
      AND EXTRACT(DAY FROM ${date}) = 28
      AND EXTRACT(DAY FROM make_date(EXTRACT(YEAR FROM ${date})::int, 3, 1) - 1) = 28))`;
}
