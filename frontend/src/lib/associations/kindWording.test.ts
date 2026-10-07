import { describe, expect, it } from 'vitest';
import { wordingFor, type AssociationKind } from './kindWording';

const KINDS: AssociationKind[] = ['association', 'list', 'institution'];

describe('wordingFor', () => {
  it('an institution never reads as an association, in any sentence of the edit flow', () => {
    const w = wordingFor('institution');
    const sentences = [
      w.editTitle(),
      ...Object.values(w.danger).map((f) => f()),
      ...Object.values(w.lydia).map((f) => f()),
    ];
    for (const s of sentences) expect(s.toLowerCase()).not.toMatch(/association|club/);
  });

  it.each(KINDS)('%s resolves a non-empty message for every row', (kind) => {
    const w = wordingFor(kind);
    for (const f of [...Object.values(w.danger), ...Object.values(w.lydia)]) {
      expect(f().trim()).not.toBe('');
    }
  });

  it('a deleted entity lands on ITS directory', () => {
    expect(wordingFor('association').directoryHref).toBe('/associations');
    expect(wordingFor('list').directoryHref).toBe('/lists');
    expect(wordingFor('institution').directoryHref).toBe('/institutions');
  });
});
