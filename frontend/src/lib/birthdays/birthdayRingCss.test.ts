/**
 * THE BIRTHDAY RING'S CSS AGREES WITH ITS TS (decision 3, docs/wiki/birthdays.md): the ring width
 * is written once in `app.css` and once in `ringWidthPx`; the four colour tokens exist in both
 * themes; and the twinkle stops under reduced motion. Read from the stylesheet text, since no
 * engine here computes the cascade.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ringWidthPx } from './confettiLayout';

const css = readFileSync(new URL('../../app.css', import.meta.url), 'utf8');

describe('birthday ring css', () => {
  it('has the ring inset max(2px, 6%), which is ringWidthPx', () => {
    expect(css).toMatch(/\.birthday-ring \{[^}]*inset: calc\(-1 \* max\(2px, 6%\)\);/);
    expect(ringWidthPx(10)).toBe(2);
    expect(ringWidthPx(100)).toBe(6);
  });

  it('declares --birthday-c0..3 and the ring gradient in light and in dark', () => {
    const dark = css.indexOf(":root[data-theme='dark'] {");
    expect(dark).toBeGreaterThan(0);
    for (const block of [css.slice(0, dark), css.slice(dark)]) {
      for (let n = 0; n < 4; n++) expect(block).toContain(`--birthday-c${n}:`);
      expect(block).toContain('--birthday-ring: conic-gradient(');
    }
  });

  it('stops the twinkle under prefers-reduced-motion', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.birthday-confetti \{\s*animation: none;/
    );
  });
});
