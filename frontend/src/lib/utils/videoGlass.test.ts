/**
 * WHICH DEVICES ADD THE BLUR ON TOP OF THE VIDEO CONTROLS' ONE RECIPE (owner, 2026-11-15): iOS only;
 * Android is measured and refused, a desktop keeps the base recipe.
 */
import { describe, expect, it } from 'vitest';
import { decideVideoGlass } from './videoGlass';

describe('decideVideoGlass', () => {
  it('adds the blur on iOS', () => {
    expect(decideVideoGlass({ ios: true })).toBe('blur');
  });

  it('keeps the base recipe, with no blur, everywhere else (Android measured 98-99 % janky)', () => {
    expect(decideVideoGlass({ ios: false })).toBe('fake');
  });
});
