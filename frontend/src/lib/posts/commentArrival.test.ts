import { describe, expect, it } from 'vitest';
import { commentArrivals } from './commentArrival';

describe('commentArrivals', () => {
  it('does not animate the first draw of a thread, even a one-comment thread', () => {
    const known = new Set<string>();
    expect(commentArrivals(known, ['a'], false)).toEqual([]);
    expect(known.size).toBe(1);
  });

  it('animates a single new comment, once', () => {
    const known = new Set(['a', 'b']);
    expect(commentArrivals(known, ['a', 'b', 'c'], true)).toEqual(['c']);
    expect(commentArrivals(known, ['a', 'b', 'c'], true)).toEqual([]);
  });

  it('treats a page of older comments as no arrival', () => {
    const known = new Set(['c']);
    expect(commentArrivals(known, ['a', 'b', 'c'], true)).toEqual([]);
    expect(known.has('a')).toBe(true);
  });
});
