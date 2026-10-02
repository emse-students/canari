import { describe, expect, it } from 'vitest';
import { mediaFrameStyle, resolveMediaSize, validMediaSize } from './mediaFrame';
import { mediaAspectStyle } from './mediaLayout';

describe('mediaFrame', () => {
  it('refuses a size that cannot draw a box', () => {
    expect(validMediaSize(undefined, 10)).toBeNull();
    expect(validMediaSize(0, 10)).toBeNull();
    expect(validMediaSize(-4, 10)).toBeNull();
    expect(validMediaSize(Number.NaN, 10)).toBeNull();
    expect(validMediaSize(498.4, 280.6)).toEqual({ width: 498, height: 281 });
  });

  it('prefers what the sender declared over what this device measured', () => {
    const measured = { width: 100, height: 100 };
    expect(resolveMediaSize({ width: 640, height: 480 }, measured)).toEqual({
      width: 640,
      height: 480,
    });
    expect(resolveMediaSize({}, measured)).toEqual(measured);
    expect(resolveMediaSize({}, null)).toBeNull();
  });

  it('`fill` is exactly the feed helper, so the chat and the feed share one ceiling', () => {
    expect(mediaFrameStyle({ size: { width: 800, height: 600 }, sizing: 'fill' })).toBe(
      mediaAspectStyle(800, 600)
    );
    expect(mediaFrameStyle({ size: null, sizing: 'fill', fallbackAspect: 16 / 9 })).toBe(
      mediaAspectStyle(undefined, undefined, 16 / 9)
    );
  });

  it('`intrinsic` is the medium own size, bounded by the height ceiling and the container', () => {
    const style = mediaFrameStyle({
      size: { width: 498, height: 280 },
      sizing: 'intrinsic',
      maxHeight: '16rem',
    });
    const ratio = 498 / 280;
    expect(style).toBe(
      `aspect-ratio: ${ratio}; width: min(498px, calc(16rem * ${ratio})); max-width: 100%`
    );
  });

  it('`intrinsic` never puts a percentage inside the width - a w-fit bubble sizes FROM it', () => {
    const style = mediaFrameStyle({ size: { width: 200, height: 100 }, sizing: 'intrinsic' });
    const width = /(?:^|; )width: ([^;]+)/.exec(style)?.[1] ?? '';
    expect(width).not.toContain('%');
  });

  it('`intrinsic` with no size yet draws the fallback ratio at the ceiling', () => {
    expect(mediaFrameStyle({ size: null, sizing: 'intrinsic', maxHeight: '16rem' })).toBe(
      `aspect-ratio: ${4 / 3}; width: calc(16rem * ${4 / 3}); max-width: 100%`
    );
  });
});
