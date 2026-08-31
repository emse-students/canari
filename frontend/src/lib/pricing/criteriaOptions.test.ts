import { describe, expect, it } from 'vitest';
import { FIRST_PROMO_YEAR, isPromoYear, lastPromoYear, promoYears } from './criteriaOptions';

/**
 * The promo domain, which is the whole of what the picker needs to know.
 *
 * It used to be a five-year window computed from the academic year, on the reading that a promo was
 * a GRADUATION year. It is an ENTRY year - la promo 2024 entered in 2024 - so the window offered six
 * cohorts nobody on prod belonged to and omitted the three largest that do. The domain is now fixed
 * and needs no round trip, which is the property these tests pin.
 */
describe('promo years', () => {
  const AUGUST = new Date('2026-08-23T12:00:00Z');
  /** After the academic-year roll: the promo list must NOT move, unlike the old window. */
  const SEPTEMBER = new Date('2026-09-23T12:00:00Z');

  it('runs from the current calendar year back to the founding year', () => {
    const years = promoYears(AUGUST);
    expect(years[0]).toBe(2026);
    expect(years.at(-1)).toBe(FIRST_PROMO_YEAR);
    expect(years).toHaveLength(2026 - FIRST_PROMO_YEAR + 1);
  });

  it('is most recent first, so the cohorts in use are the ones on screen', () => {
    expect(promoYears(AUGUST).slice(0, 5)).toEqual([2026, 2025, 2024, 2023, 2022]);
  });

  // The academic-year roll is what made the old window shift under a form that had not changed.
  it('does not move in September', () => {
    expect(promoYears(SEPTEMBER)).toEqual(promoYears(AUGUST));
  });

  it('offers every cohort on prod', () => {
    const years = promoYears(AUGUST);
    for (const seen of [2022, 2023, 2024, 2025, 2026, 2020, 1850, 1816]) {
      expect(years).toContain(seen);
    }
  });

  // The list, the guard and the message a manager reads all take their upper bound from here, so a
  // fourth reading of "the current year" cannot creep in and disagree with the other three.
  it('bounds itself with lastPromoYear', () => {
    expect(lastPromoYear(AUGUST)).toBe(2026);
    expect(lastPromoYear(SEPTEMBER)).toBe(2026);
    expect(promoYears(AUGUST)[0]).toBe(lastPromoYear(AUGUST));
    expect(isPromoYear(lastPromoYear(AUGUST), AUGUST)).toBe(true);
    expect(isPromoYear(lastPromoYear(AUGUST) + 1, AUGUST)).toBe(false);
  });

  describe('isPromoYear', () => {
    it('accepts the bounds themselves', () => {
      expect(isPromoYear(FIRST_PROMO_YEAR, AUGUST)).toBe(true);
      expect(isPromoYear(2026, AUGUST)).toBe(true);
    });

    // `2O24` typed for `2024` is the realistic way a bad year is written, and it would price a whole
    // cohort as "everyone else" in silence. The server holds the same bound.
    it('refuses a year that could match nobody, for ever', () => {
      expect(isPromoYear(1815, AUGUST)).toBe(false);
      expect(isPromoYear(2027, AUGUST)).toBe(false);
      expect(isPromoYear(2024.5, AUGUST)).toBe(false);
      expect(isPromoYear(Number.NaN, AUGUST)).toBe(false);
    });
  });
});
