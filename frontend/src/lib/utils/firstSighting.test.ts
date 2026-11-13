import { describe, expect, it } from 'vitest';
import { createFirstSighting } from './firstSighting';

describe('createFirstSighting', () => {
  it('answers true once per key, then false', () => {
    const first = createFirstSighting();
    expect(first('a')).toBe(true);
    expect(first('a')).toBe(false);
    expect(first('b')).toBe(true);
    expect(first('')).toBe(true);
    expect(first('')).toBe(false);
  });

  it('keeps one memory per predicate', () => {
    const one = createFirstSighting();
    const two = createFirstSighting();
    expect(one('a')).toBe(true);
    expect(two('a')).toBe(true);
  });
});
