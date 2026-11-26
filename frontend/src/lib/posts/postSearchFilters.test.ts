import { describe, expect, it } from 'vitest';
import { hasSearchCriteria, matchAssociations, searchQueryString } from './postSearchFilters';

describe('the post search criteria', () => {
  it('names something to look for with words or at least one filter', () => {
    expect(hasSearchCriteria({ q: '  ' })).toBe(false);
    expect(hasSearchCriteria({ q: 'gala' })).toBe(true);
    expect(hasSearchCriteria({ q: '', authorId: 'u1' })).toBe(true);
    expect(hasSearchCriteria({ q: '', associationId: 'a1' })).toBe(true);
  });

  it('puts the words, each filter set and the page on the wire, and nothing else', () => {
    expect(searchQueryString({ q: ' gala ' }, { limit: 20 })).toBe('q=gala&limit=20');
    const both = new URLSearchParams(
      searchQueryString({ q: '', authorId: 'u1', associationId: 'a1' }, { limit: 20, offset: 40 })
    );
    expect(Object.fromEntries(both)).toEqual({
      q: '',
      authorId: 'u1',
      associationId: 'a1',
      limit: '20',
      offset: '40',
    });
  });
});

describe('matchAssociations', () => {
  const list = [{ name: 'Bureau des Élèves' }, { name: 'Club Photo' }, { name: 'Ecole de danse' }];

  it('matches a name without regard to case or accents', () => {
    expect(matchAssociations(list, 'eleves')).toEqual([{ name: 'Bureau des Élèves' }]);
    expect(matchAssociations(list, 'ÉCOLE')).toEqual([{ name: 'Ecole de danse' }]);
  });

  it('lists the first ones for an empty query, capped', () => {
    expect(matchAssociations(list, '', 2)).toHaveLength(2);
  });
});
