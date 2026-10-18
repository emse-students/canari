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

  it('never splits an emoji: a hard cut lands between code points, not inside a surrogate pair', () => {
    // 19 characters are kept; the 19th is an emoji, which a UTF-16 unit cut at 19 would have halved.
    const text = `${'a'.repeat(18)}\u{1F600}${'b'.repeat(30)}`;
    const out = truncateForMeta(text, 20);
    expect(out).toBe(`${'a'.repeat(18)}\u{1F600}…`);
    expect(out.isWellFormed()).toBe(true);
    // A run of emoji with no spaces keeps every emoji whole, whatever the budget.
    for (const max of [5, 6, 7, 10]) {
      const run = truncateForMeta('\u{1F389}'.repeat(40), max);
      expect(run.isWellFormed()).toBe(true);
      expect(Array.from(run)).toHaveLength(max);
    }
  });
});
