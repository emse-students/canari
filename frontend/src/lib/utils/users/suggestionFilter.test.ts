import { describe, expect, it } from 'vitest';
import { filterUserSuggestions } from './suggestionFilter';

const users = (...ids: string[]) => ids.map((id) => ({ id, displayName: id }));

describe('filterUserSuggestions', () => {
  it('returns everything when no rule is given', () => {
    expect(filterUserSuggestions(users('a', 'b'))).toHaveLength(2);
  });

  it('hides an excluded id', () => {
    const kept = filterUserSuggestions(users('a', 'b'), { excludeIds: ['a'] });
    expect(kept.map((u) => u.id)).toEqual(['b']);
  });

  it('hides an excluded id whose CASE differs from the search result', () => {
    // The defect this whole seam exists for: the multi-select stores ids lowercased while the
    // search endpoint returns them as stored, so an exact-match filter excluded nobody.
    const kept = filterUserSuggestions(users('AbC-123'), { excludeIds: ['abc-123'] });
    expect(kept).toEqual([]);
  });

  it('hides an excluded id whose case differs the other way round', () => {
    const kept = filterUserSuggestions(users('abc-123'), { excludeIds: ['ABC-123'] });
    expect(kept).toEqual([]);
  });

  it('keeps only allowlisted ids, case-insensitively', () => {
    const kept = filterUserSuggestions(users('a', 'b', 'c'), { filterUserIds: ['A', 'c'] });
    expect(kept.map((u) => u.id)).toEqual(['a', 'c']);
  });

  it('applies both rules together, with exclusion winning over the allowlist', () => {
    const kept = filterUserSuggestions(users('a', 'b'), {
      filterUserIds: ['a', 'b'],
      excludeIds: ['b'],
    });
    expect(kept.map((u) => u.id)).toEqual(['a']);
  });

  it('preserves the server order', () => {
    const kept = filterUserSuggestions(users('c', 'a', 'b'), { excludeIds: ['a'] });
    expect(kept.map((u) => u.id)).toEqual(['c', 'b']);
  });

  it('is unaffected by empty strings in the exclusion list', () => {
    // Call sites pass an optional current-user id that may be '' before the session resolves;
    // that must not start hiding real users.
    const kept = filterUserSuggestions(users('a'), { excludeIds: [''] });
    expect(kept.map((u) => u.id)).toEqual(['a']);
  });
});
