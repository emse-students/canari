/** What the CanaReels rail's heart and numbers say (`reelRail.ts`). */
import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_REACTION } from '$lib/posts/postReaction';
import { compactCount, railHeartToggle, reactionTotal } from './reelRail';

describe('railHeartToggle', () => {
  it('gives "J\'aime" to a reader holding no reaction', () => {
    expect(railHeartToggle({ bob: 'Rire' }, 'alice')).toEqual({
      type: DOUBLE_TAP_REACTION,
      wasReacted: false,
    });
  });

  it("takes back the reader's own reaction, whatever its kind", () => {
    expect(railHeartToggle({ alice: 'Rire' }, 'alice')).toEqual({ type: 'Rire', wasReacted: true });
  });
});

describe('reactionTotal', () => {
  it('counts every reaction, and none on a post without any', () => {
    expect(reactionTotal({ a: 'x', b: 'y' })).toBe(2);
    expect(reactionTotal(undefined)).toBe(0);
  });
});

describe('compactCount', () => {
  it('prints nothing for zero: the empty icon says it', () => {
    expect(compactCount(0, 'fr')).toBe('');
  });

  it('prints a small count as it is, a large one compact in the reader language', () => {
    expect(compactCount(12, 'en')).toBe('12');
    expect(compactCount(1200, 'en')).toBe('1.2K');
  });
});
