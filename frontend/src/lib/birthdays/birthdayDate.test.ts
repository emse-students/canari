import { describe, expect, it } from 'vitest';
import {
  formatCalendarDate,
  birthdayMonthNames,
  daysInBirthdayMonth,
  formatBirthday,
  isBirthdayDate,
} from './birthdayDate';

describe('birthday dates on the client', () => {
  it('offers 29 days in February - a birthday some years have - and the month lengths otherwise', () => {
    expect(daysInBirthdayMonth(2)).toBe(29);
    expect(daysInBirthdayMonth(4)).toBe(30);
    expect(daysInBirthdayMonth(12)).toBe(31);
  });

  it('accepts exactly the dates the server accepts', () => {
    expect(isBirthdayDate(2, 29)).toBe(true);
    expect(isBirthdayDate(2, 30)).toBe(false);
    expect(isBirthdayDate(4, 31)).toBe(false);
    expect(isBirthdayDate(13, 1)).toBe(false);
    expect(isBirthdayDate(0, 1)).toBe(false);
    expect(isBirthdayDate(6, 0)).toBe(false);
    expect(isBirthdayDate(3.5, 2)).toBe(false);
  });

  it('writes a day and a month with no year, in the reader language, 29 February included', () => {
    expect(formatBirthday({ month: 3, day: 14 }, 'fr')).toBe('14 mars');
    expect(formatBirthday({ month: 3, day: 14 }, 'en')).toBe('March 14');
    expect(formatBirthday({ month: 2, day: 29 }, 'fr')).toBe('29 février');
    expect(formatBirthday({ month: 1, day: 1 }, 'fr')).not.toMatch(/\d{4}/);
  });

  it('names the twelve months, January first', () => {
    const fr = birthdayMonthNames('fr');
    expect(fr).toHaveLength(12);
    expect(fr[0]).toBe('janvier');
    expect(fr[11]).toBe('décembre');
  });

  it('writes the calendar date the server sent as is, whatever the device zone', () => {
    expect(formatCalendarDate('2026-12-08', 'fr')).toBe('8 décembre 2026');
    expect(formatCalendarDate('2027-01-01', 'en')).toBe('January 1, 2027');
  });
});
