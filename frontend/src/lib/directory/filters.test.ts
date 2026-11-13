import { describe, expect, it } from 'vitest';
import {
  activeChips,
  emptyFilters,
  hasCriteria,
  promoOf,
  withoutFilter,
  type DirectoryFilters,
} from './filters';

const f = (patch: Partial<DirectoryFilters>): DirectoryFilters => ({ ...emptyFilters(), ...patch });

describe('hasCriteria', () => {
  it('is false for an untouched screen and for a one-letter name', () => {
    expect(hasCriteria(emptyFilters())).toBe(false);
    expect(hasCriteria(f({ query: ' a ' }))).toBe(false);
  });

  it('is true for a two-letter name or for any single filter', () => {
    expect(hasCriteria(f({ query: 'al' }))).toBe(true);
    expect(hasCriteria(f({ promo: 2024 }))).toBe(true);
    expect(hasCriteria(f({ formation: 'ICM' }))).toBe(true);
    expect(hasCriteria(f({ associationId: 'a1' }))).toBe(true);
    expect(hasCriteria(f({ campus: 'gardanne' }))).toBe(true);
    expect(hasCriteria(f({ post: 'ALUMNI' }))).toBe(true);
  });
});

describe('promoOf', () => {
  it('reads a cleared number input (null) and an empty string as no promo', () => {
    expect(promoOf(f({ promo: null }))).toBeUndefined();
    expect(promoOf(f({ promo: '' }))).toBeUndefined();
    expect(promoOf(f({ promo: '2025' }))).toBe(2025);
  });
});

describe('activeChips', () => {
  it('lists the active filters in sheet order and never the name', () => {
    const chips = activeChips(
      f({ query: 'zoe', promo: 2024, formation: ' ICM ', campus: 'gardanne', associationId: 'a1' }),
      (id) => (id === 'a1' ? 'BDE' : null)
    );
    expect(chips.map((c) => c.key)).toEqual(['promo', 'formation', 'associationId', 'campus']);
    expect(chips.find((c) => c.key === 'formation')?.label).toBe('ICM');
    expect(chips.find((c) => c.key === 'associationId')?.label).toBe('BDE');
  });

  it('falls back to a generic label for an association the list does not hold', () => {
    const chips = activeChips(f({ associationId: 'gone' }), () => null);
    expect(chips[0].label.length).toBeGreaterThan(0);
  });
});

describe('withoutFilter', () => {
  it('clears one criterion and keeps the rest', () => {
    const next = withoutFilter(f({ query: 'zoe', promo: 2024, post: 'EMSE' }), 'promo');
    expect(next.promo).toBe('');
    expect(next.query).toBe('zoe');
    expect(next.post).toBe('EMSE');
  });
});
