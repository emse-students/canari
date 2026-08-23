import { describe, expect, it } from 'vitest';
import {
  addBucket,
  addDimension,
  allCellKeys,
  gridLayout,
  isComplete,
  matrixOf,
  matrixPayload,
  matrixProblem,
  newBucket,
  newDimension,
  OTHERS_BUCKET_ID,
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

  describe('layout', () => {
    it('puts the last criterion across the top', () => {
      let m = withCotisation();
      m = addDimension(m, { ...newDimension('formation'), id: 'f' });
      m = addBucket(m, 'f', { id: 'icm', label: 'ICM', values: ['ICM'] });
      const { columns, rows } = gridLayout(m);
      expect(columns.map((c) => c.id)).toEqual(['icm', OTHERS_BUCKET_ID]);
      expect(rows.map((r) => r.ids)).toEqual([['yes'], [OTHERS_BUCKET_ID]]);
    });

    it('gives a single criterion one row', () => {
      const { columns, rows } = gridLayout(withCotisation());
      expect(columns).toHaveLength(2);
      expect(rows).toEqual([{ ids: [], labels: [] }]);
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

    it('says nothing about a form with no grid', () => {
      expect(matrixProblem(null)).toBeNull();
    });
  });
});
