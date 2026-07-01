import type { SelectQueryBuilder } from 'typeorm';
import {
  splitSearchTerms,
  isFuzzyEligible,
  applyFuzzyNameSearch,
  FUZZY_TERM_THRESHOLD,
} from './userSearch';

/** Minimal chainable query-builder spy recording andWhere / addSelect / orderBy calls. */
function makeQbSpy() {
  const andWhere: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const orderBy: Array<{ field: string; dir?: string }> = [];
  let addSelectSql = '';
  const qb: Record<string, jest.Mock> = {};
  qb.andWhere = jest.fn((sql: string, params: Record<string, unknown> = {}) => {
    andWhere.push({ sql, params });
    return qb;
  });
  qb.addSelect = jest.fn((sql: string) => {
    addSelectSql = sql;
    return qb;
  });
  qb.setParameter = jest.fn(() => qb);
  qb.orderBy = jest.fn((field: string, dir?: string) => {
    orderBy.push({ field, dir });
    return qb;
  });
  qb.addOrderBy = jest.fn((field: string, dir?: string) => {
    orderBy.push({ field, dir });
    return qb;
  });
  return {
    qb: qb as unknown as SelectQueryBuilder<{ id: string }>,
    andWhere,
    orderBy,
    getAddSelect: () => addSelectSql,
  };
}

describe('splitSearchTerms', () => {
  it('splits on any whitespace and drops empties', () => {
    expect(splitSearchTerms('  jean   dupont ')).toEqual(['jean', 'dupont']);
  });
  it('returns an empty array for blank input', () => {
    expect(splitSearchTerms('   ')).toEqual([]);
    expect(splitSearchTerms('')).toEqual([]);
  });
});

describe('isFuzzyEligible', () => {
  it('is false for 1-2 char terms and true from 3 chars', () => {
    expect(isFuzzyEligible('a')).toBe(false);
    expect(isFuzzyEligible('jo')).toBe(false);
    expect(isFuzzyEligible('jol')).toBe(true);
  });
});

describe('applyFuzzyNameSearch', () => {
  it('returns false and touches nothing when there are no terms', () => {
    const { qb, andWhere, orderBy } = makeQbSpy();
    expect(applyFuzzyNameSearch(qb, '   ')).toBe(false);
    expect(andWhere).toHaveLength(0);
    expect(orderBy).toHaveLength(0);
  });

  it('adds a fuzzy branch (substring OR word_similarity) for a >=3 char term', () => {
    const { qb, andWhere } = makeQbSpy();
    applyFuzzyNameSearch(qb, 'jolan');
    expect(andWhere).toHaveLength(1);
    expect(andWhere[0].sql).toContain('LIKE');
    expect(andWhere[0].sql).toContain('word_similarity');
    expect(andWhere[0].params).toMatchObject({
      like0: '%jolan%',
      term0: 'jolan',
      fuzzyThreshold: FUZZY_TERM_THRESHOLD,
    });
  });

  it('uses substring-only matching for a short (<3 char) term', () => {
    const { qb, andWhere } = makeQbSpy();
    applyFuzzyNameSearch(qb, 'jo');
    expect(andWhere).toHaveLength(1);
    expect(andWhere[0].sql).toContain('LIKE');
    expect(andWhere[0].sql).not.toContain('word_similarity');
  });

  it('ANDs one condition per term so word order is irrelevant', () => {
    const { qb, andWhere } = makeQbSpy();
    applyFuzzyNameSearch(qb, 'dupont jean');
    expect(andWhere).toHaveLength(2);
    expect(andWhere[0].params).toMatchObject({ like0: '%dupont%' });
    expect(andWhere[1].params).toMatchObject({ like1: '%jean%' });
  });

  it('orders by the computed relevance score first, then name', () => {
    const { qb, orderBy, getAddSelect } = makeQbSpy();
    applyFuzzyNameSearch(qb, 'jolan');
    expect(getAddSelect()).toContain('similarity');
    expect(orderBy[0]).toEqual({ field: 'search_score', dir: 'DESC' });
    expect(orderBy[1]).toEqual({ field: 'user.displayName', dir: 'ASC' });
  });
});
