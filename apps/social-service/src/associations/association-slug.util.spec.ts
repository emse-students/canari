import {
  SLUG_MAX_ATTEMPTS,
  SLUG_PATTERN,
  slugCandidates,
  slugifyName,
} from './association-slug.util';

describe('slugifyName', () => {
  it('lowercases, folds accents and hyphenates', () => {
    expect(slugifyName("Bureau des Élèves d'Été")).toBe('bureau-des-eleves-d-ete');
    expect(slugifyName('  --Liste  Canari 2027!! ')).toBe('liste-canari-2027');
  });

  it('returns empty when nothing is sluggable', () => {
    expect(slugifyName('!!! ???')).toBe('');
  });
});

describe('slugCandidates', () => {
  it('starts with the bare base and then numbers from -2', () => {
    const c = slugCandidates('Club Photo');
    expect(c.slice(0, 3)).toEqual(['club-photo', 'club-photo-2', 'club-photo-3']);
    expect(c).toHaveLength(SLUG_MAX_ATTEMPTS);
  });

  it('keeps every candidate inside the service pattern, even for a very long name', () => {
    for (const name of ['x'.repeat(200), 'a', '!!!', 'é', `${'mot-'.repeat(30)}fin`]) {
      for (const slug of slugCandidates(name)) expect(slug).toMatch(SLUG_PATTERN);
    }
  });
});
