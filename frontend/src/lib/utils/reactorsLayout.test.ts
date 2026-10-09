import { describe, it, expect } from 'vitest';
import { layoutReactors } from './reactorsLayout';

describe('layoutReactors', () => {
  it('keeps a short list in one column', () => {
    expect(layoutReactors(3, 7, 2)).toEqual({ cols: 1, rows: 3, shown: 3, hidden: 0 });
  });

  it('spreads eleven names over two columns when seven rows fit (the reported case)', () => {
    expect(layoutReactors(11, 7, 2)).toEqual({ cols: 2, rows: 7, shown: 11, hidden: 0 });
  });

  it('counts what no room remains for, on the last cell', () => {
    const l = layoutReactors(200, 7, 2);
    expect(l.shown + l.hidden).toBe(200);
    expect(l.shown).toBe(13);
    expect(l.hidden).toBe(187);
  });

  it('always draws at least one row and one column', () => {
    expect(layoutReactors(2, 0, 0).cols).toBeGreaterThanOrEqual(1);
  });
});
