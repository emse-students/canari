import { readdirSync } from 'fs';
import { join } from 'path';
import {
  RESERVED_SLUGS,
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

  it('expands ligatures that NFD cannot decompose', () => {
    expect(slugifyName('Cœur de Lyon')).toBe('coeur-de-lyon');
    expect(slugifyName('Æsir')).toBe('aesir');
    expect(slugifyName('Straße')).toBe('strasse');
    expect(slugifyName('Øresund Łódź')).toBe('oresund-lodz');
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

describe('the reserved slugs', () => {
  it('equal the static folders of the three directory routes (no drift)', () => {
    const root = join(process.cwd(), '..', '..', 'frontend', 'src', 'routes');
    const statics = new Set<string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('[')) walk(join(dir, e.name));
        else {
          statics.add(e.name);
          walk(join(dir, e.name));
        }
      }
    };
    for (const d of ['associations', 'lists', 'institutions']) walk(join(root, d));
    expect([...statics].sort()).toEqual([...RESERVED_SLUGS].sort());
  });

  it('never leads the candidates with a reserved word', () => {
    for (const word of RESERVED_SLUGS) expect(slugCandidates(word)[0]).toBe(`${word}-2`);
  });
});
