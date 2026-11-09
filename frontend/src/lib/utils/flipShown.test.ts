// @vitest-environment happy-dom
/**
 * `flipShown`: a row whose box appears or disappears (the sidebar hidden by a salon open) gets no
 * animation, where `flip` divided by its 0 x 0 box and handed the engine NaN and Infinity keyframes.
 */
import { describe, expect, it } from 'vitest';
import { flipShown } from './flipShown';

const rect = (left: number, top: number, width: number, height: number) =>
  ({
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
  }) as DOMRect;

describe('flipShown', () => {
  const node = document.createElement('div');

  it.each([
    ['hidden by the reconcile', rect(0, 100, 72, 56), rect(0, 0, 0, 0)],
    ['shown by the reconcile', rect(0, 0, 0, 0), rect(0, 100, 72, 56)],
    ['a zero-height box', rect(0, 100, 72, 0), rect(0, 160, 72, 56)],
  ])('%s: no animation, so no keyframe is ever computed', (_case, from, to) => {
    const config = flipShown(node, { from, to }, { duration: 150 });
    expect(config).toEqual({ duration: 0 });
  });

  it('a row drawn before and after is flipped as before', () => {
    const config = flipShown(
      node,
      { from: rect(0, 100, 72, 56), to: rect(0, 160, 72, 56) },
      {
        duration: 150,
      }
    );
    expect(config.duration).toBe(150);
    expect(typeof config.css).toBe('function');
  });
});
