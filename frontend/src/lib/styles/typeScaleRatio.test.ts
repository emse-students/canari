/**
 * The type scale grows with `--type-scale` (iOS Dynamic Type). A font size that grows inside a
 * fixed line box overlaps its own lines and clips the composer, so every size token and its
 * line-height must carry the SAME multiplier, and `--composer-field-height` derives from the
 * line-height token rather than restating a length.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync('src/app.css', 'utf8');
const STEPS = ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'];
const scaled = (name: string) =>
  new RegExp(`--${name}: calc\\(\\s*[0-9.]+rem \\* var\\(--type-scale, 1\\)\\s*\\);`);

describe('type scale tokens', () => {
  for (const step of STEPS) {
    it(`--text-${step} and its line-height both multiply by --type-scale`, () => {
      expect(css).toMatch(scaled(`text-${step}`));
      expect(css).toMatch(scaled(`text-${step}--line-height`));
    });
  }

  it('text with no size class inherits a body size that follows --type-scale too', () => {
    const body = [...css.matchAll(/\nbody \{([^}]*)\}/g)]
      .map((m) => m[1])
      .find((rule) => rule.includes("'Nunito Variable'"));
    expect(body).toMatch(/font-size: calc\(1rem \* var\(--type-scale, 1\)\);/);
  });

  it('a markdown heading hyphenates before it breaks mid-word', () => {
    expect(css).toMatch(
      /\.post-markdown :is\(h1, h2, h3, h4, h5, h6\) \{\s*-webkit-hyphens: auto;\s*hyphens: auto;/
    );
  });

  it('the composer field height derives from the scaled line-height token', () => {
    expect(css).toMatch(/--composer-field-height: calc\(var\(--text-sm--line-height\) \+/);
  });
});

describe('boxes and glyphs that follow the text size', () => {
  it('divide or multiply by BOTH --text-zoom (Android) and --type-scale (iOS)', () => {
    expect(css).toMatch(/zoom: calc\(1 \/ \(var\(--text-zoom, 1\) \* var\(--type-scale, 1\)\)\)/);
    const boxes = css.match(
      /--value\(integer\) \* var\(--text-zoom, 1\) \* var\(--type-scale, 1\)/g
    );
    expect(boxes).toHaveLength(3);
  });
});
