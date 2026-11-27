import { describe, expect, it } from 'vitest';
import { foldQuery } from './rank';
import { snippetAround } from './snippet';

describe('snippetAround', () => {
  it('marks every typed word in the ORIGINAL text, accents included', () => {
    const s = snippetAround('La réunion de demain est à 10h', foldQuery('reunion demain'));
    const marked = s.ranges.map(([a, b]) => s.text.slice(a, b));
    expect(marked).toEqual(['réunion', 'demain']);
  });

  it('cuts a long text around the first match and says so', () => {
    const text = `${'mot '.repeat(60)}budget ${'fin '.repeat(60)}`;
    const s = snippetAround(text, foldQuery('budget'));
    expect(s.text.startsWith('\u2026')).toBe(true);
    expect(s.text.endsWith('\u2026')).toBe(true);
    expect(s.ranges.map(([a, b]) => s.text.slice(a, b))).toEqual(['budget']);
  });
});
