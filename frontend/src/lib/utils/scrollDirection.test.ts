import { describe, expect, it } from 'vitest';
import {
  INITIAL_SCROLL_DIRECTION,
  nextScrollDirection,
  type ScrollDirectionState,
} from './scrollDirection';

const run = (tops: number[], from: ScrollDirectionState = INITIAL_SCROLL_DIRECTION) =>
  tops.reduce((s, t) => nextScrollDirection(s, t), from);

describe('nextScrollDirection', () => {
  it('stays shown at the top and on an overscroll bounce above it', () => {
    expect(run([0]).shown).toBe(true);
    expect(run([-30]).shown).toBe(true);
  });

  it('hides after the dead zone going down', () => {
    expect(run([3, 6]).shown).toBe(true);
    expect(run([3, 6, 40]).shown).toBe(false);
  });

  it('shows again as soon as the reader scrolls up past the dead zone, wherever they are', () => {
    expect(run([100, 400, 392]).shown).toBe(true);
    expect(run([100, 400, 396]).shown).toBe(false);
  });

  it('ignores a jitter below the dead zone in either direction', () => {
    const hidden = run([100, 400]);
    expect(run([403, 399, 402, 398], hidden).shown).toBe(false);
    const shown = run([400, 380]);
    expect(run([383, 381, 385], shown).shown).toBe(true);
  });

  it('measures the return from where the reader turned, not from the first scroll', () => {
    expect(run([200, 1000, 995]).shown).toBe(false);
    expect(run([200, 1000, 995, 990]).shown).toBe(true);
  });

  it('shows at the top again after being hidden', () => {
    expect(run([500, 0]).shown).toBe(true);
  });

  it('returns the same state object when nothing changed', () => {
    expect(nextScrollDirection(INITIAL_SCROLL_DIRECTION, 0)).toBe(INITIAL_SCROLL_DIRECTION);
  });
});
