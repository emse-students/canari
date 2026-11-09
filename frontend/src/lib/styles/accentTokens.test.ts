/**
 * ONE ACCENT, AND IT DOES ONE JOB PER TOKEN, OR THIS FAILS.
 *
 * Measured on 2026-11-09 (docs/wiki/frontend/design-reference.md, "One accent"): 637 `amber-*`
 * utilities lived next to 571 `cn-yellow` ones, and the two yellows drew the SAME jobs - the active
 * tab glyph was orange (`#e17100`), the feed pill amber, the follow chip brand yellow. The owner
 * took option B (one accent for the chrome) and rule C (a link or a counter uses the text token).
 * Nothing would have reported a new `text-amber-600`: it compiles, lints and renders. This is the
 * instrument aimed at it.
 *
 * THREE CLAIMS.
 * 1. The Tailwind amber SCALE (`amber-50` ... `amber-950`) appears nowhere in shipped code. Amber's
 *    only legitimate job is the WARNING colour, spelt `amber-warn` (a token that flips with the
 *    theme), which this pattern does not match. A justified exception goes in `ALLOWED_RAW_AMBER`,
 *    BY FILE AND BY COUNT, with its reason - and an entry whose usage has gone fails too, so the
 *    list cannot go stale.
 * 2. `cn-yellow` is no longer a UTILITY (`text-cn-yellow`, `border-cn-yellow`...): the fill is
 *    `accent`, the text is `accent-text`, the glyph is `accent-icon`. The CSS variable stays as an
 *    alias of `--accent`, so there is one value, not two.
 * 3. Every pairing keeps WCAG AA, RECOMPUTED from `app.css` so a token cannot drift under the
 *    ratios the wiki quotes: text 4.5:1, glyph and border 3:1, ink on the fill 4.5:1.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shippedSourceFiles, withoutAnyComments } from './markupSources';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = readFileSync(join(src, 'app.css'), 'utf8');

/** Raw amber-scale usages that are justified, by file and exact count. None today. */
const ALLOWED_RAW_AMBER: Record<string, { count: number; why: string }> = {};

const RAW_AMBER = /(?<![\w-])amber-(?:50|100|200|300|400|500|600|700|800|900|950)(?![\w-])/g;
const CN_YELLOW_UTILITY =
  /(?<![\w-])(?:[a-z0-9-]+:)*(?:text|bg|border|ring|from|to|via|fill|stroke|outline|decoration|divide|shadow)(?:-[trblxyse])?-cn-yellow(?:-hover)?(?![\w-])/g;

function count(re: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of shippedSourceFiles(src)) {
    const body = withoutAnyComments(readFileSync(file, 'utf8'));
    const n = body.match(re)?.length ?? 0;
    if (n > 0) found[relative(src, file).replaceAll(sep, '/')] = n;
  }
  return found;
}

describe('the amber scale is not an accent', () => {
  it('appears only where ALLOWED_RAW_AMBER says, by count', () => {
    const found = count(RAW_AMBER);
    const expected = Object.fromEntries(
      Object.entries(ALLOWED_RAW_AMBER).map(([f, e]) => [f, e.count])
    );
    expect(found).toEqual(expected);
    for (const entry of Object.values(ALLOWED_RAW_AMBER))
      expect(entry.why.length).toBeGreaterThan(20);
  });

  it('cn-yellow is not a utility any more', () => {
    expect(count(CN_YELLOW_UTILITY)).toEqual({});
  });
});

/** The value of `--name` in the `:root` block that is not the theme block, or the dark block. */
function token(name: string, dark: boolean): string {
  const start = dark
    ? css.indexOf(":root[data-theme='dark'] {")
    : css.indexOf('--cn-dark: #050505;');
  const end = dark ? css.indexOf('\n}', start) : css.indexOf('\n}', start);
  const block = css.slice(start, end);
  const m = block.match(new RegExp(String.raw`(?<![\w-])--${name}:\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`--${name} not found in the ${dark ? 'dark' : 'light'} block`);
  return m[1];
}

function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** `fg` at `alpha` over `bg`, as `#rrggbb` (what `bg-accent/20` paints). */
function over(fg: string, bg: string, alpha: number): string {
  const ch = (i: number) =>
    Math.round(
      parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha)
    );
  return `#${[1, 3, 5].map((i) => ch(i).toString(16).padStart(2, '0')).join('')}`;
}

describe('the active place is an ink glyph on the accent pill', () => {
  it('the bottom nav paints the active icon box with accent and on-accent', () => {
    const nav = readFileSync(join(src, 'lib/components/navigation/BottomNav.svelte'), 'utf8');
    expect(nav).toMatch(/rounded-full[^"]*\{isActive\s*\?\s*'bg-accent text-on-accent'/);
    expect(nav).toContain('motion-safe:transition-');
  });
});

describe('every accent pairing keeps WCAG AA', () => {
  for (const dark of [false, true]) {
    const theme = dark ? 'dark' : 'light';
    const surfaces = dark
      ? ['#000000', '#121212', '#242424']
      : ['#ffffff', token('cn-bg', false), token('cn-surface-alt', false)];
    const accent = token('accent', dark);
    const onAccent = token('on-accent', dark);
    const text = token('accent-text', dark);
    const icon = token('accent-icon', dark);

    it(`${theme}: ink on the fill is 4.5:1`, () => {
      expect(ratio(onAccent, accent)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${theme}: accent-text is 4.5:1 on every surface and on its own 20% tint`, () => {
      for (const s of surfaces) {
        expect(ratio(text, s)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(text, over(accent, s, 0.2))).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${theme}: accent-icon is 3:1 on every surface`, () => {
      for (const s of surfaces) expect(ratio(icon, s)).toBeGreaterThanOrEqual(3);
    });
  }

  it('cn-yellow is an alias of the accent, never a second value', () => {
    expect(css).toMatch(/--cn-yellow:\s*var\(--accent\)/);
    expect(css).not.toMatch(/--cn-yellow:\s*#/);
  });
});
