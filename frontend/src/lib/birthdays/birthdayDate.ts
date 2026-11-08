/**
 * A birthday's day and month on the client: how many days a month offers in the picker, and how a
 * date reads in the reader's language. Pure, so both are pinned without a DOM.
 *
 * The rule of WHICH day celebrates a birthday (29 February on the 28th of a common year) is the
 * SERVER's alone (`birthdays/birthday-date.ts` in social-service): the client never decides "today",
 * it draws what `GET /api/posts/birthdays/today` answered.
 */
import type { BirthdayDate } from './api';

/** The longest each month can be, February counting its 29th - the server's CHECK, index 0 = January. */
const MONTH_LENGTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** How many days `month` (1..12) offers: 29 for February, a birthday some years have. */
export function daysInBirthdayMonth(month: number): number {
  return MONTH_LENGTH[month - 1] ?? 31;
}

/** Whether (month, day) is a date some year has - the same rule as the server's. */
export function isBirthdayDate(month: number, day: number): boolean {
  return (
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInBirthdayMonth(month)
  );
}

/**
 * The day and month as the reader's language writes them, with no year: "14 mars", "March 14". The
 * date is built in a LEAP year (2000) and formatted in UTC, so 29 February exists and no time zone
 * can move it to a neighbouring day.
 */
export function formatBirthday(date: BirthdayDate, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(Date.UTC(2000, date.month - 1, date.day));
}

/** The twelve month names in the reader's language, January first, for the picker. */
export function birthdayMonthNames(locale: string): string[] {
  const format = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
  return MONTH_LENGTH.map((_, index) => format.format(Date.UTC(2000, index, 1)));
}
