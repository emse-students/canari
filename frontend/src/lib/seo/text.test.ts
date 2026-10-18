import { describe, expect, it } from 'vitest';
import { truncateForMeta } from './text';

describe('truncateForMeta', () => {
  it('leaves a text that fits untouched', () => {
    expect(truncateForMeta('Soiree au foyer', 60)).toBe('Soiree au foyer');
  });

  it('cuts between words, never inside one, and stays within the budget', () => {
    const out = truncateForMeta('Rendez-vous jeudi soir au foyer pour un moment convivial', 30);
    expect(out).toBe('Rendez-vous jeudi soir au…');
    expect(out.length).toBeLessThanOrEqual(30);
  });

  it('drops the punctuation a cut leaves dangling before the ellipsis', () => {
    expect(truncateForMeta('Gala, soiree, concert et bien plus encore', 15)).toBe('Gala, soiree…');
  });

  it('cuts a single unbroken word hard rather than returning nothing', () => {
    const out = truncateForMeta('a'.repeat(50), 20);
    expect(out).toBe(`${'a'.repeat(19)}…`);
  });
});
