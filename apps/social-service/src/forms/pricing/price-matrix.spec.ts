import {
  allCellKeys,
  assertMatrixValid,
  expectedCellCount,
  pricedQuestionIds,
  pricingViewFor,
  resolveCellPrice,
  type PriceMatrix,
} from './price-matrix';
import { OTHERS_BUCKET_ID, type Dimension, type SubmitterFacts } from './audience';

describe('price matrix', () => {
  const facts = (over: Partial<SubmitterFacts> = {}): SubmitterFacts => ({
    promo: null,
    formation: null,
    cotisationTiers: [],
    answers: {},
    ...over,
  });

  const cotisation: Dimension = {
    id: 'cot',
    kind: 'cotisation',
    buckets: [{ id: 'yes', label: 'Cotisant', anyTier: true }],
  };
  const formation: Dimension = {
    id: 'form',
    kind: 'formation',
    buckets: [{ id: 'icm', label: 'ICM', values: ['ICM'] }],
  };
  const menu: Dimension = {
    id: 'menu',
    kind: 'answer',
    questionId: 'q_menu',
    buckets: [
      { id: 'veg', label: 'Vegetarien', values: ['opt_veg'] },
      { id: 'meat', label: 'Viande', values: ['opt_meat'] },
    ],
  };

  /** Every combination of two 1-bucket dimensions: 2 x 2. */
  const twoByTwo: PriceMatrix = {
    dimensions: [cotisation, formation],
    cells: {
      'yes|icm': 800,
      [`yes|${OTHERS_BUCKET_ID}`]: 1000,
      [`${OTHERS_BUCKET_ID}|icm`]: 1500,
      [`${OTHERS_BUCKET_ID}|${OTHERS_BUCKET_ID}`]: 2000,
    },
  };

  describe('shape', () => {
    // The "+1" is the generated `others` bucket, and it is why a criterion with one group still has
    // two columns. Getting this wrong would make every completeness check wrong in the same way.
    it('counts buckets plus one per dimension', () => {
      expect(expectedCellCount([cotisation])).toBe(2);
      expect(expectedCellCount([cotisation, formation])).toBe(4);
      expect(expectedCellCount([cotisation, formation, menu])).toBe(12);
    });

    it('enumerates keys in dimension order', () => {
      expect(allCellKeys([cotisation, formation])).toEqual([
        'yes|icm',
        `yes|${OTHERS_BUCKET_ID}`,
        `${OTHERS_BUCKET_ID}|icm`,
        `${OTHERS_BUCKET_ID}|${OTHERS_BUCKET_ID}`,
      ]);
    });
  });

  describe('resolution', () => {
    it('prices each of the four corners', () => {
      expect(resolveCellPrice(twoByTwo, facts({ cotisationTiers: [null], formation: 'ICM' }))).toBe(
        800
      );
      expect(resolveCellPrice(twoByTwo, facts({ cotisationTiers: [null] }))).toBe(1000);
      expect(resolveCellPrice(twoByTwo, facts({ formation: 'ICM' }))).toBe(1500);
      expect(resolveCellPrice(twoByTwo, facts())).toBe(2000);
    });

    // The invariant is enforced at save time, so a gap here means it was bypassed. Charging a
    // plausible number instead of saying so is how a wrong price ships quietly.
    it('refuses rather than inventing a price when a cell is missing', () => {
      const broken: PriceMatrix = { dimensions: [cotisation], cells: { yes: 800 } };
      expect(() => resolveCellPrice(broken, facts())).toThrow(/no price for your situation/i);
    });
  });

  describe('assertMatrixValid', () => {
    const ok = () => JSON.parse(JSON.stringify(twoByTwo)) as PriceMatrix;

    it('accepts a complete grid', () => {
      expect(() => assertMatrixValid(ok())).not.toThrow();
    });

    it('refuses a grid with no criterion', () => {
      expect(() => assertMatrixValid({ dimensions: [], cells: {} })).toThrow(
        /at least one criterion/i
      );
    });

    it('refuses a criterion with no group', () => {
      expect(() =>
        assertMatrixValid({
          dimensions: [{ id: 'empty', kind: 'formation', buckets: [] }],
          cells: { [OTHERS_BUCKET_ID]: 100 },
        })
      ).toThrow(/separates nobody/i);
    });

    it('refuses a missing cell, and says how many', () => {
      const m = ok();
      delete m.cells['yes|icm'];
      expect(() => assertMatrixValid(m)).toThrow(/incomplete: 1 price/i);
    });

    // An extra cell means the document and its dimensions disagree - usually a group renamed
    // without its cells following, which would then read as a complete grid of the wrong shape.
    it('refuses a cell matching no combination', () => {
      const m = ok();
      m.cells['yes|nonexistent'] = 500;
      expect(() => assertMatrixValid(m)).toThrow(/match no combination/i);
    });

    it('refuses a group using the reserved "everyone else" id', () => {
      expect(() =>
        assertMatrixValid({
          dimensions: [
            {
              id: 'd',
              kind: 'formation',
              buckets: [{ id: OTHERS_BUCKET_ID, label: 'x', values: ['ICM'] }],
            },
          ],
          cells: {},
        })
      ).toThrow(/reserved/i);
    });

    it('refuses overlapping groups, naming both', () => {
      expect(() =>
        assertMatrixValid({
          dimensions: [
            {
              id: 'd',
              kind: 'formation',
              buckets: [
                { id: 'a', label: 'A', values: ['ICM'] },
                { id: 'b', label: 'B', values: ['ICM'] },
              ],
            },
          ],
          cells: { a: 1, b: 2, [OTHERS_BUCKET_ID]: 3 },
        })
      ).toThrow(/"a" and "b".*depend on their order/is);
    });

    it('refuses a negative or fractional price', () => {
      const m = ok();
      m.cells['yes|icm'] = -1;
      expect(() => assertMatrixValid(m)).toThrow(/whole number of cents/i);
      m.cells['yes|icm'] = 12.5;
      expect(() => assertMatrixValid(m)).toThrow(/whole number of cents/i);
    });

    // The cap is what stops a manager building a grid nobody can fill; the message says the number.
    it('refuses a grid past the cell cap', () => {
      const many: Dimension[] = Array.from({ length: 3 }, (_, i) => ({
        id: `d${i}`,
        kind: 'formation' as const,
        buckets: Array.from({ length: 9 }, (_, j) => ({
          id: `b${i}_${j}`,
          label: `B${j}`,
          values: [`V${i}_${j}`],
        })),
      }));
      expect(() => assertMatrixValid({ dimensions: many, cells: {} }, 400)).toThrow(
        /1000 prices to fill/
      );
    });
  });

  // A question the grid prices on has already been paid for by the cell it selected.
  describe('pricedQuestionIds', () => {
    it('names the questions used as criteria, and nothing else', () => {
      expect([...pricedQuestionIds({ dimensions: [cotisation, menu], cells: {} })]).toEqual([
        'q_menu',
      ]);
      expect([...pricedQuestionIds({ dimensions: [cotisation], cells: {} })]).toEqual([]);
      expect([...pricedQuestionIds(null)]).toEqual([]);
    });
  });

  /**
   * The slice handed to the fill page: profile criteria resolved here, answer criteria left open.
   * What the page must NOT receive is anybody else's price.
   */
  describe('pricingViewFor', () => {
    const withMenu: PriceMatrix = {
      dimensions: [cotisation, menu],
      cells: {
        'yes|veg': 700,
        'yes|meat': 900,
        [`yes|${OTHERS_BUCKET_ID}`]: 600,
        [`${OTHERS_BUCKET_ID}|veg`]: 1700,
        [`${OTHERS_BUCKET_ID}|meat`]: 1900,
        [`${OTHERS_BUCKET_ID}|${OTHERS_BUCKET_ID}`]: 1600,
      },
    };

    it('resolves the profile criteria and keeps only that row', () => {
      const view = pricingViewFor(withMenu, facts({ cotisationTiers: ['avec-alcool'] }));
      expect(view.appliedLabels).toEqual(['Cotisant']);
      expect(view.cells).toEqual({ veg: 700, meat: 900, [OTHERS_BUCKET_ID]: 600 });
      expect(view.answerDimensions).toHaveLength(1);
      expect(view.answerDimensions[0].questionId).toBe('q_menu');
    });

    // A non-cotisant must not be able to read the cotisant column out of their own quote.
    it('does not leak the other profile row', () => {
      const view = pricingViewFor(withMenu, facts());
      expect(Object.values(view.cells)).toEqual(expect.not.arrayContaining([700, 900, 600]));
    });

    // The page shows a total from its first render, before anything is answered.
    it('quotes the unanswered price as the base', () => {
      expect(pricingViewFor(withMenu, facts()).baseCents).toBe(1600);
    });

    it('reports the questions whose modifiers must not be added', () => {
      expect(pricingViewFor(withMenu, facts()).ignoredModifierQuestionIds).toEqual(['q_menu']);
    });

    it('leaves nothing open when every criterion is a profile one', () => {
      const view = pricingViewFor(twoByTwo, facts({ formation: 'ICM' }));
      expect(view.answerDimensions).toEqual([]);
      expect(view.baseCents).toBe(1500);
      expect(view.appliedLabels).toEqual(['ICM']);
    });
  });
});
