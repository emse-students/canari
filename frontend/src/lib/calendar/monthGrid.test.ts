/**
 * THE SHAPE OF A MONTH, PINNED - because it was written twice and is now written once.
 *
 * These assert the properties both former copies relied on without stating: whole weeks at both
 * ends, Monday first, and a last day asked of `Date` rather than computed.
 */
import { describe, it, expect } from 'vitest';
import { localizedWeekdays, monthGridDays } from './monthGrid';

describe('monthGridDays', () => {
  it('pads to whole weeks at both ends', () => {
    const cells = monthGridDays(new Date(2026, 8, 1));

    expect(cells.length % 7).toBe(0);
    expect(cells.filter((d) => d !== null)).toHaveLength(30);
  });

  /** September 2026 starts on a Tuesday, so exactly one leading blank. */
  it('puts the 1st under the weekday it actually falls on, Monday first', () => {
    const cells = monthGridDays(new Date(2026, 8, 1));

    expect(cells.slice(0, 2)).toEqual([null, 1]);
  });

  /** A month starting ON a Monday needs no leading pad - the off-by-one the `+ 6` guards. */
  it('adds no leading blank to a month that starts on a Monday', () => {
    const cells = monthGridDays(new Date(2026, 5, 1));

    expect(cells[0]).toBe(1);
  });

  it('asks Date for the last day rather than assuming one', () => {
    expect(monthGridDays(new Date(2024, 1, 1)).filter((d) => d !== null)).toHaveLength(29);
    expect(monthGridDays(new Date(2026, 1, 1)).filter((d) => d !== null)).toHaveLength(28);
  });

  /** The day of the month passed in must not matter - only its month. */
  it('answers the same for any day of the same month', () => {
    expect(monthGridDays(new Date(2026, 8, 30))).toEqual(monthGridDays(new Date(2026, 8, 1)));
  });
});

describe('localizedWeekdays', () => {
  it('starts the week on Monday', () => {
    expect(localizedWeekdays('fr-FR', 'long')[0]).toBe('Lundi');
    expect(localizedWeekdays('en-US', 'long')[0]).toBe('Monday');
  });

  /**
   * THE DIFFERENCE THAT MADE THE TWO COPIES VISIBLE: the grid lower-cased and truncated, the sheet
   * capitalised and dropped the dot, so the same header read differently on the two surfaces.
   */
  it('capitalises and drops the abbreviation dot', () => {
    const short = localizedWeekdays('fr-FR', 'short');

    expect(short[0]).toBe('Lun');
    expect(short.some((d) => d.endsWith('.'))).toBe(false);
  });

  it('returns seven names', () => {
    expect(localizedWeekdays('fr-FR', 'short')).toHaveLength(7);
  });
});
