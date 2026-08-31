import { BadRequestException } from '@nestjs/common';
import {
  FIRST_PROMO_YEAR,
  parseAudienceCondition,
  parsePriceMatrix,
  type CriteriaContext,
} from './validate';

/**
 * What the parser refuses, and why each refusal is a real submitter rather than a style rule.
 *
 * The promo bound is the one added when `yearsToGraduation` was deleted. A promo outside it matches
 * NOBODY, for ever, and a criterion that silently matches nobody is exactly what this module exists
 * to catch - the graduation-year modes it replaced were themselves two criteria that matched nobody
 * and were saved without complaint.
 */
describe('criteria validation', () => {
  const ctx: CriteriaContext = { tierKeys: [], questions: new Map() };
  /** Derived, never hard-coded: asserting a literal year would make this test expire. */
  const THIS_YEAR = new Date().getFullYear();

  const promoCondition = (values: unknown) =>
    parseAudienceCondition({ promo: { values } }, ctx, 'submitCondition');

  describe('a promo is an entry year between the founding year and today', () => {
    it('accepts both bounds and everything between', () => {
      expect(promoCondition([FIRST_PROMO_YEAR, 2024, THIS_YEAR])).toEqual({
        promo: { values: [FIRST_PROMO_YEAR, 2024, THIS_YEAR] },
      });
    });

    // The school did not exist, so no user can carry it. `2O24` typed for `2024` is how this is
    // really written, and it would price a whole cohort as "everyone else" in silence.
    it('refuses a year before the school existed', () => {
      expect(() => promoCondition([FIRST_PROMO_YEAR - 1])).toThrow(BadRequestException);
    });

    // Nobody has entered yet. A form saved with it prices nobody and nobody notices until autumn.
    it('refuses a year nobody can have entered in yet', () => {
      expect(() => promoCondition([THIS_YEAR + 1])).toThrow(BadRequestException);
    });

    it('names the offending year and the range, because the manager has to fix it', () => {
      expect(() => promoCondition([3024])).toThrow(
        `submitCondition.promo.values holds 3024, which is not a promo: they run from ${FIRST_PROMO_YEAR} to ${THIS_YEAR}.`
      );
    });

    it('refuses anything that is not a whole year', () => {
      expect(() => promoCondition(['2024'])).toThrow(BadRequestException);
      expect(() => promoCondition([2024.5])).toThrow(BadRequestException);
      expect(() => promoCondition(2024)).toThrow(BadRequestException);
    });

    // An empty criterion is not "no constraint", it is a criterion matching nobody.
    it('refuses an empty list', () => {
      expect(() => promoCondition([])).toThrow(BadRequestException);
    });

    it('refuses a condition with no criterion at all, which would apply to everybody', () => {
      expect(() => parseAudienceCondition({}, ctx, 'submitCondition')).toThrow(BadRequestException);
    });
  });

  // The dimension path shares the promo parser, so the bound cannot be bypassed by pricing on it.
  describe('a promo dimension of the grid', () => {
    const matrix = (values: number[]) => ({
      dimensions: [{ id: 'd1', kind: 'promo', buckets: [{ id: 'b1', label: '2A', values }] }],
      cells: { b1: 1000, _others: 2000 },
    });

    it('accepts a grid whose promos are real and whose cells are complete', () => {
      expect(parsePriceMatrix(matrix([2024]), ctx).dimensions[0]).toEqual({
        id: 'd1',
        kind: 'promo',
        buckets: [{ id: 'b1', label: '2A', values: [2024] }],
      });
    });

    it('refuses a promo outside the range, exactly as a condition does', () => {
      expect(() => parsePriceMatrix(matrix([THIS_YEAR + 1]), ctx)).toThrow(BadRequestException);
    });
  });
});
