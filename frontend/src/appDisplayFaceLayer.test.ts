/**
 * THE DISPLAY FACE IS A DEFAULT FOR `h1`, NOT AN OVERRIDE.
 *
 * `h1, .font-brand, .font-display { font-family: var(--font-display) }` was written outside any
 * layer, and unlayered CSS outranks Tailwind's utilities (which live in a layer), so every
 * `font-body` opt-out written on an `h1` computed to Fredoka. This gate asserts the rule sits
 * inside `@layer base`, where a utility on the element wins.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const APP_CSS = readFileSync('src/app.css', 'utf8');

/** Whether the character at `index` is inside an open `@layer base {` block. */
function insideLayerBase(css: string, index: number): boolean {
  const opener = '@layer base {';
  let from = 0;
  for (;;) {
    const start = css.indexOf(opener, from);
    if (start === -1 || start > index) return false;
    let depth = 0;
    let i = start + opener.length - 1;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    if (index < i) return true;
    from = i;
  }
}

describe('the display face rule', () => {
  it('sits inside @layer base, so font-body on an h1 wins', () => {
    const rule = /(^|\n)\s*h1,\s*\n\s*\.font-brand,\s*\n\s*\.font-display\s*\{/;
    const match = rule.exec(APP_CSS);
    expect(match, 'the h1 / .font-brand / .font-display rule exists').not.toBeNull();
    expect(insideLayerBase(APP_CSS, match!.index + 1)).toBe(true);
    expect(APP_CSS.match(new RegExp(rule.source, 'g'))).toHaveLength(1);
  });
});
