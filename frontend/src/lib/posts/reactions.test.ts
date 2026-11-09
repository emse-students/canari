import { describe, expect, it } from 'vitest';
import { REACTIONS, reactionCountsOf, reactionTypeToLabel } from './reactions';

describe('reactionCountsOf', () => {
  it('counts the map by type', () => {
    expect(reactionCountsOf({ reactions: { a: 'x', b: 'x', c: 'y' } })).toEqual({ x: 2, y: 1 });
    expect(reactionCountsOf({})).toEqual({});
  });

  it("adds the tally of a post whose people are withheld to the reader's own entry", () => {
    // owner, 2026-11-04: the map holds the reader's own only, the rest comes as a tally.
    expect(
      reactionCountsOf({ reactions: { me: 'x' }, otherReactionCounts: { x: 2, z: 1 } })
    ).toEqual({ x: 3, z: 1 });
  });
});

describe('reactionTypeToLabel', () => {
  it('names every reaction through Paraglide, never by its stored key', () => {
    for (const { type } of REACTIONS) {
      expect(reactionTypeToLabel(type)).toBeTruthy();
    }
    expect(reactionTypeToLabel('Marteau')).toBe('Marteau');
  });
});
