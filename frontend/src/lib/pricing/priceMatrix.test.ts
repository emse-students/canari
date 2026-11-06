import { describe, expect, it } from 'vitest';
import {
  addBucket,
  addDimension,
  allCellKeys,
  emptyMatrix,
  crossKey,
  fillCells,
  gridAxes,
  guestFreeCellKey,
  lineCellKeys,
  parseEuros,
  rowUnavailable,
  hasCell,
  isComplete,
  matrixOf,
  matrixPayload,
  matrixProblem,
  newBucket,
  newDimension,
  OTHERS_BUCKET_ID,
  priceRange,
  removeBucket,
  removeDimension,
  type PriceMatrix,
} from './priceMatrix';

/**
 * The editor's job is to keep the grid COMPLETE while the manager works, because completeness is a
 * save-time invariant on the server. Every test here is about a grid staying whole, and about no
 * edit silently changing what somebody pays.
 */
describe('price matrix editing', () => {
  const withCotisation = (): PriceMatrix => {
    const d = { ...newDimension('cotisation'), id: 'cot' };
    return addBucket(addDimension({ dimensions: [], cells: {} }, d), 'cot', {
      id: 'yes',
      label: 'Cotisant',
      anyTier: true,
    });
  };

  it('starts a grid complete, with one column and its "everyone else"', () => {
    const m = withCotisation();
    expect(allCellKeys(m.dimensions)).toEqual(['yes', OTHERS_BUCKET_ID]);
    expect(isComplete(m)).toBe(true);
  });

  // Turning a criterion on must not reprice anybody: every new cell inherits the price of the cell
  // it was split out of.
  it('carries existing prices into a new criterion', () => {
    let m = withCotisation();
    m.cells.yes = 8;
    m.cells[OTHERS_BUCKET_ID] = 20;
    m = addDimension(m, { ...newDimension('formation'), id: 'f' });
    m = addBucket(m, 'f', { id: 'icm', label: 'ICM', values: ['ICM'] });
    expect(m.cells['yes|icm']).toBe(8);
    expect(m.cells[`yes|${OTHERS_BUCKET_ID}`]).toBe(8);
    expect(m.cells[`${OTHERS_BUCKET_ID}|icm`]).toBe(20);
    expect(m.cells[`${OTHERS_BUCKET_ID}|${OTHERS_BUCKET_ID}`]).toBe(20);
    expect(isComplete(m)).toBe(true);
  });

  // A new group describes people who were in "everyone else" a moment ago, so that is the price it
  // starts from - not zero, which would be a free ticket nobody asked for.
  it('starts a new group from the "everyone else" price', () => {
    let m = withCotisation();
    m.cells[OTHERS_BUCKET_ID] = 20;
    m = addBucket(m, 'cot', { id: 'alcool', label: 'Avec alcool', variantKeys: ['avec-alcool'] });
    expect(m.cells.alcool).toBe(20);
    expect(isComplete(m)).toBe(true);
  });

  // Removing a criterion means "stop distinguishing", so the surviving price is the one that applied
  // to everybody it was NOT selecting. Keeping the discount would apply it to all.
  it('keeps the "everyone else" price when a criterion is removed', () => {
    let m = withCotisation();
    m.cells.yes = 8;
    m.cells[OTHERS_BUCKET_ID] = 20;
    m = addDimension(m, { ...newDimension('formation'), id: 'f' });
    m = addBucket(m, 'f', { id: 'icm', label: 'ICM', values: ['ICM'] });
    m.cells['yes|icm'] = 5;
    m = removeDimension(m, 'f');
    expect(m.cells).toEqual({ yes: 8, [OTHERS_BUCKET_ID]: 20 });
    expect(isComplete(m)).toBe(true);
  });

  it('removes a group and the cells naming it', () => {
    let m = withCotisation();
    m = addBucket(m, 'cot', { id: 'alcool', label: 'Avec alcool', variantKeys: ['avec-alcool'] });
    m = removeBucket(m, 'cot', 'alcool');
    expect(Object.keys(m.cells).sort()).toEqual([OTHERS_BUCKET_ID, 'yes'].sort());
    expect(isComplete(m)).toBe(true);
  });

  it('removes the last criterion back to an empty grid', () => {
    const m = removeDimension(withCotisation(), 'cot');
    expect(m.dimensions).toEqual([]);
    expect(matrixPayload(m, true)).toBeNull();
  });

  /**
   * `null` is a third value beside a price and a hole: the manager saying that combination does not
   * exist. Every edit has to carry it as faithfully as it carries a number, because losing it turns
   * a closed combination into a free one - the expensive direction to be wrong in.
   */
  describe('unavailable cells', () => {
    it('counts as decided, unlike an absent key', () => {
      const m = withCotisation();
      m.cells.yes = null;
      m.cells[OTHERS_BUCKET_ID] = 20;
      expect(hasCell(m.cells, 'yes')).toBe(true);
      expect(isComplete(m)).toBe(true);
      delete m.cells.yes;
      expect(hasCell(m.cells, 'yes')).toBe(false);
      expect(isComplete(m)).toBe(false);
    });

    // A price of 0 is free and has to stay a price: it is the value `hasCell` is easiest to lose.
    it('keeps a free cell apart from an unavailable one', () => {
      const m = withCotisation();
      m.cells.yes = 0;
      m.cells[OTHERS_BUCKET_ID] = null;
      expect(matrixPayload(m, true)).toEqual({
        dimensions: m.dimensions,
        cells: { yes: 0, [OTHERS_BUCKET_ID]: null },
      });
      expect(matrixOf(matrixPayload(m, true))?.cells).toEqual({
        yes: 0,
        [OTHERS_BUCKET_ID]: null,
      });
    });

    it('spreads to the cells a new criterion splits it into', () => {
      let m = withCotisation();
      m.cells.yes = null;
      m.cells[OTHERS_BUCKET_ID] = 20;
      m = addDimension(m, { ...newDimension('formation'), id: 'f' });
      m = addBucket(m, 'f', { id: 'icm', label: 'ICM', values: ['ICM'] });
      expect(m.cells['yes|icm']).toBeNull();
      expect(m.cells[`yes|${OTHERS_BUCKET_ID}`]).toBeNull();
      expect(m.cells[`${OTHERS_BUCKET_ID}|icm`]).toBe(20);
      expect(isComplete(m)).toBe(true);
    });

    // The surviving value is the "everyone else" column's, whatever it is - so a criterion removed
    // above an unavailable column leaves the combination unavailable, not priced.
    it('survives a criterion being removed', () => {
      let m = withCotisation();
      m.cells.yes = 8;
      m.cells[OTHERS_BUCKET_ID] = null;
      m = addDimension(m, { ...newDimension('formation'), id: 'f' });
      m = addBucket(m, 'f', { id: 'icm', label: 'ICM', values: ['ICM'] });
      m = removeDimension(m, 'f');
      expect(m.cells).toEqual({ yes: 8, [OTHERS_BUCKET_ID]: null });
    });

    it('is left out of the price range', () => {
      const m = withCotisation();
      m.cells.yes = 8;
      m.cells[OTHERS_BUCKET_ID] = null;
      expect(priceRange(m)).toEqual({ min: 8, max: 8 });
    });

    it('has no range at all when nothing is available', () => {
      const m = withCotisation();
      m.cells.yes = null;
      m.cells[OTHERS_BUCKET_ID] = null;
      expect(priceRange(m)).toBeNull();
    });

    it('has no range on a form with no grid', () => {
      expect(priceRange(null)).toBeNull();
    });
  });

  describe('layout', () => {
    const twoCriteria = (): PriceMatrix => {
      let m = withCotisation();
      m = addDimension(m, { ...newDimension('formation'), id: 'f' });
      return addBucket(m, 'f', { id: 'icm', label: 'ICM', values: ['ICM'] });
    };

    it('puts the first criterion down the side and the second across the top', () => {
      const { columns, rows } = gridAxes(twoCriteria());
      expect(columns.map((c) => c.ids)).toEqual([['icm'], [OTHERS_BUCKET_ID]]);
      expect(rows.map((r) => r.ids)).toEqual([['yes'], [OTHERS_BUCKET_ID]]);
      expect(crossKey(rows[0], columns[1])).toBe(`yes|${OTHERS_BUCKET_ID}`);
    });

    it('gives a single criterion one row per group and a single price column', () => {
      const { columns, rows } = gridAxes(withCotisation());
      expect(rows.map((r) => r.key)).toEqual(['yes', OTHERS_BUCKET_ID]);
      expect(columns).toEqual([{ ids: [], labels: [], key: '' }]);
      expect(crossKey(rows[0], columns[0])).toBe('yes');
    });

    it('still lays out a stored grid of three criteria, the extra ones nested in the rows', () => {
      let m = twoCriteria();
      m = addDimension(m, { ...newDimension('promo'), id: 'p' });
      m = addBucket(m, 'p', { id: 'y', label: '1A', values: [2026] });
      const { columns, rows } = gridAxes(m);
      expect(rows).toHaveLength(4);
      expect(columns).toHaveLength(2);
      const keys = rows.flatMap((r) => columns.map((c) => crossKey(r, c)));
      expect(keys.sort()).toEqual(allCellKeys(m.dimensions).sort());
    });

    it('fills a whole row or column, and nothing else', () => {
      const m = twoCriteria();
      const axes = gridAxes(m);
      const filled = fillCells(m, lineCellKeys(axes, 'column', 'icm'), 12);
      expect(filled.cells['yes|icm']).toBe(12);
      expect(filled.cells[`${OTHERS_BUCKET_ID}|icm`]).toBe(12);
      expect(filled.cells[`yes|${OTHERS_BUCKET_ID}`]).toBe(m.cells[`yes|${OTHERS_BUCKET_ID}`]);
      const closed = fillCells(m, lineCellKeys(axes, 'row', 'yes'), null);
      expect(rowUnavailable(closed, axes.rows[0], axes.columns)).toBe(true);
      expect(rowUnavailable(closed, axes.rows[1], axes.columns)).toBe(false);
      expect(isComplete(closed)).toBe(true);
    });
  });

  describe('typed prices', () => {
    it('reads an empty box as free and a comma as a decimal point', () => {
      expect(parseEuros('')).toBe(0);
      expect(parseEuros(' 12,5 ')).toBe(12.5);
      expect(parseEuros('abc')).toBeNull();
      expect(parseEuros('-3')).toBeNull();
    });
  });

  describe('the guest seat of a public form', () => {
    const charging = (): PriceMatrix => {
      const m = withCotisation();
      m.cells.yes = 10;
      m.cells[OTHERS_BUCKET_ID] = 0;
      return m;
    };

    it('flags the all-"everyone else" cell priced 0 in a grid that charges', () => {
      expect(guestFreeCellKey(charging(), [])).toBe(OTHERS_BUCKET_ID);
    });

    it('flags nothing once that cell is priced, closed, or the grid charges nobody', () => {
      const priced = charging();
      priced.cells[OTHERS_BUCKET_ID] = 5;
      expect(guestFreeCellKey(priced, [])).toBeNull();
      const closed = charging();
      closed.cells[OTHERS_BUCKET_ID] = null;
      expect(guestFreeCellKey(closed, [])).toBeNull();
      const free = charging();
      free.cells.yes = 0;
      expect(guestFreeCellKey(free, [])).toBeNull();
    });

    it('never flags a named group priced 0 - only the true fallback', () => {
      const m = charging();
      m.cells.yes = 0;
      m.cells[OTHERS_BUCKET_ID] = 10;
      expect(guestFreeCellKey(m, [])).toBeNull();
    });

    it('flags nothing when a required question puts every answer in a group', () => {
      let m: PriceMatrix = { dimensions: [], cells: {} };
      m = addDimension(m, { ...newDimension('answer', { questionId: 'q' }), id: 'a' });
      m = addBucket(m, 'a', { id: 'o1', label: 'Oui', values: ['yes'] });
      m.cells.o1 = 10;
      m.cells[OTHERS_BUCKET_ID] = 0;
      const item = {
        id: 'q',
        type: 'single_choice',
        required: true,
        options: [{ id: 'yes' }],
      };
      expect(guestFreeCellKey(m, [item])).toBeNull();
      expect(guestFreeCellKey(m, [{ ...item, required: false }])).toBe(OTHERS_BUCKET_ID);
    });
  });

  describe('payload', () => {
    it('converts euros to cents for every combination', () => {
      const m = withCotisation();
      m.cells.yes = 8.5;
      m.cells[OTHERS_BUCKET_ID] = 20;
      expect(matrixPayload(m, true)).toEqual({
        dimensions: m.dimensions,
        cells: { yes: 850, [OTHERS_BUCKET_ID]: 2000 },
      });
    });

    // Null has to be SENT: an absent field leaves the stored grid in place, so a grid switched off
    // would stay on.
    it('is null when the form takes no payment', () => {
      expect(matrixPayload(withCotisation(), false)).toBeNull();
    });

    it('round-trips through matrixOf', () => {
      const m = withCotisation();
      m.cells.yes = 8;
      m.cells[OTHERS_BUCKET_ID] = 20;
      expect(matrixOf(matrixPayload(m, true))?.cells).toEqual({ yes: 8, [OTHERS_BUCKET_ID]: 20 });
    });

    it('reads no grid from null, an empty document, or no dimensions', () => {
      expect(matrixOf(null)).toBeNull();
      expect(matrixOf({})).toBeNull();
      expect(matrixOf({ dimensions: [], cells: {} })).toBeNull();
    });
  });

  // Said here so the manager is not told about cell keys by a 400.
  describe('problems named before saving', () => {
    it('accepts a finished grid', () => {
      const m = withCotisation();
      m.cells.yes = 8;
      m.cells[OTHERS_BUCKET_ID] = 20;
      expect(matrixProblem(m)).toBeNull();
    });

    it('names a criterion with no group', () => {
      const m = addDimension(
        { dimensions: [], cells: {} },
        { ...newDimension('formation'), id: 'f' }
      );
      expect(matrixProblem(m)).toBe('empty_criterion');
    });

    it('names an unnamed group', () => {
      let m = withCotisation();
      m = addBucket(m, 'cot', { ...newBucket('cotisation', '  '), id: 'x' });
      expect(matrixProblem(m)).toBe('unnamed_group');
    });

    it('names a group with nothing selected', () => {
      let m = addDimension(
        { dimensions: [], cells: {} },
        { ...newDimension('formation'), id: 'f' }
      );
      m = addBucket(m, 'f', { id: 'icm', label: 'ICM', values: [] });
      expect(matrixProblem(m)).toBe('empty_group');
    });

    it('names a cotisation group naming no tier', () => {
      let m = addDimension(
        { dimensions: [], cells: {} },
        { ...newDimension('cotisation'), id: 'c' }
      );
      m = addBucket(m, 'c', { id: 'b', label: 'Cotisant', anyTier: false, variantKeys: [] });
      expect(matrixProblem(m)).toBe('empty_group');
    });

    it('names an answer criterion with no question chosen', () => {
      let m = addDimension({ dimensions: [], cells: {} }, { ...newDimension('answer'), id: 'a' });
      m = addBucket(m, 'a', { id: 'b', label: 'Veg', values: ['opt'] });
      expect(matrixProblem(m)).toBe('no_question');
    });

    it('names an incomplete grid', () => {
      const m = withCotisation();
      delete m.cells.yes;
      expect(matrixProblem(m)).toBe('incomplete');
    });

    // The grid is ON and divides on nothing. `matrixPayload` sends null for it, so a save would
    // look accepted while quietly keeping the single price - the manager has to be told.
    it('names a grid switched on with no criterion', () => {
      expect(matrixProblem(emptyMatrix(20))).toBe('no_criterion');
    });

    it('names a grid where every combination is unavailable', () => {
      const m = withCotisation();
      m.cells.yes = null;
      m.cells[OTHERS_BUCKET_ID] = null;
      expect(matrixProblem(m)).toBe('all_unavailable');
    });

    it('accepts a grid where only some combinations are unavailable', () => {
      const m = withCotisation();
      m.cells.yes = 8;
      m.cells[OTHERS_BUCKET_ID] = null;
      expect(matrixProblem(m)).toBeNull();
    });

    it('says nothing about a form with no grid', () => {
      expect(matrixProblem(null)).toBeNull();
    });
  });
});
