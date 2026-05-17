import { describe, expect, it } from 'vitest';
import { DEFAULT_MEDIA_ASPECT, mediaAspectStyle, normalizedAspectRatio } from './mediaLayout';

describe('mediaLayout', () => {
  it('uses fallback when dimensions are missing', () => {
    expect(normalizedAspectRatio(undefined, undefined)).toBe(DEFAULT_MEDIA_ASPECT);
    expect(mediaAspectStyle()).toBe(`aspect-ratio: ${DEFAULT_MEDIA_ASPECT}`);
  });

  it('computes ratio from width and height', () => {
    expect(normalizedAspectRatio(800, 600)).toBeCloseTo(4 / 3);
    expect(mediaAspectStyle(800, 600)).toBe('aspect-ratio: 1.3333333333333333');
  });

  it('clamps extreme ratios', () => {
    expect(normalizedAspectRatio(100, 1000)).toBe(0.25);
    expect(normalizedAspectRatio(4000, 100)).toBe(4);
  });
});
