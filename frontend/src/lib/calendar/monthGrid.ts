/**
 * THE SHAPE OF A MONTH, ONCE - the squares it has and the labels above them.
 *
 * This module exists because the same seven lines were written twice, in the two places that draw a
 * month: `MonthCalendarGridRich.svelte` and `calendarExport.ts`. Duplication in this corner is not
 * theoretical - on 2026-09-16 a private copy of "which day does this event belong to" survived the
 * 05:00 boundary landing beside it, and both painted surfaces kept the old rule while the list next
 * to them had the new one. A rule with two implementations is a rule that will be half-fixed.
 *
 * Which EVENTS fall on a square is a different question and lives in `feedEvents.ts`. This file
 * only knows about squares.
 */

/**
 * The Monday-first squares of `focusDate`'s month: a day number, or null for a padding cell.
 *
 * Padded at BOTH ends to a whole number of weeks, so a caller can lay the result out in a 7-column
 * grid without counting. The last day is asked of `Date` (day 0 of the next month) rather than
 * computed from a table, which is what makes February and leap years uninteresting.
 */
export function monthGridDays(focusDate: Date): (number | null)[] {
  const year = focusDate.getFullYear();
  const month = focusDate.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const mondayIndex = (new Date(year, month, 1).getDay() + 6) % 7;
  const cells: (number | null)[] = [];
  for (let i = 0; i < mondayIndex; i++) cells.push(null);
  for (let day = 1; day <= lastDay; day++) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/**
 * Localized Monday-first weekday names for a locale via Intl (no hardcoded strings).
 *
 * `style` picks abbreviated ('short', e.g. "Lun"/"Mon") or full ('long', e.g. "Lundi"/"Monday");
 * the first letter is upper-cased and any trailing abbreviation dot is dropped for a clean header.
 *
 * The screen grid used to carry its own copy that lower-cased and truncated to three characters, so
 * the header read "lun" on screen and "Lun" on the sheet the grid is meant to be a preview of. One
 * implementation, one answer.
 */
export function localizedWeekdays(locale: string, style: 'short' | 'long'): string[] {
  const fmt = new Intl.DateTimeFormat(locale, { weekday: style });
  // 2024-01-01 is a Monday; walk the 7 following days for a Monday-first week.
  return Array.from({ length: 7 }, (_, i) => {
    const name = fmt.format(new Date(2024, 0, 1 + i)).replace(/\.$/, '');
    return name.charAt(0).toUpperCase() + name.slice(1);
  });
}
