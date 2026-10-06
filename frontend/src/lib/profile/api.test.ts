import { describe, expect, it } from 'vitest';
import { parseSkyEntourage } from './api';

describe('parseSkyEntourage', () => {
  it('reads `{ found: false }` as an empty tree instead of leaving the lists undefined', () => {
    expect(parseSkyEntourage({ found: false })).toEqual({
      found: false,
      parrains: [],
      fillots: [],
    });
  });

  it('keeps both lists of a full answer', () => {
    const m = { prenom: 'A', nom: 'B', level: 1, kind: 'parrainage', sub: null };
    expect(parseSkyEntourage({ found: true, parrains: [m], fillots: [] }).parrains).toEqual([m]);
  });

  it.each([null, 'html', 3, []])('refuses %j, which is not an entourage', (body) => {
    expect(() => parseSkyEntourage(body)).toThrow();
  });
});
