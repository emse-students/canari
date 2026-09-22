/**
 * ONE UNLAYERED RULE WAS DELETING EVERY `transition-*` UTILITY IN THE APP.
 *
 * `app.css` gives the theme a crossfade by declaring, on a list of bare element selectors,
 * `transition: background-color 180ms ease, color 180ms ease, border-color 180ms ease`. It was
 * written OUTSIDE any layer, and unlayered CSS outranks everything in a layer whatever its
 * specificity - Tailwind's utilities live in `@layer utilities`. So on every `nav`, `aside`,
 * `header`, `button`, `a`, `input`, `textarea` and `select`, an authored `transition-all
 * duration-300` computed to the theme triple at 180ms and animated nothing it was written for.
 *
 * Measured against the local estate on 2026-09-22, by reading `getComputedStyle().transitionProperty`
 * on every element matching that selector list:
 *
 * | Page | elements with a `transition-*` class | of those, overridden |
 * | --- | --- | --- |
 * | `/posts` | 28 | 28 |
 * | `/chat` | 22 | 22 |
 *
 * All of them, on both pages. THE VISIBLE ONE IS WHAT FOUND IT: hovering the navigation rail
 * SNAPPED it from 72px to 336px, because its `transition-all duration-300` never applied, while the
 * labels inside - `<span>`, which the rule does not name - went on fading in over their own 300ms.
 * For about 150ms the reader sees a blank white sheet that then fills with text.
 *
 * Neutralising the unlayered rule in the live page and re-declaring it inside `@layer base` moved
 * the count to 0 of 28, put the rail back to `all / 0.3s`, and left 6 of the 9 elements with no
 * transition of their own still taking the theme crossfade - which is the whole intent, kept.
 *
 * This gate asserts the layer, because the rule reads as ordinary CSS either way and nothing else
 * in the build would notice it moving back out.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Read from the project root, the way `appIcons.test.ts` next door does: a test file at `src/` is
// not served with a `file:` URL here, so `import.meta.url` cannot be resolved against.
const APP_CSS = readFileSync('src/app.css', 'utf8');

/** Returns the body of every `@layer <name> {...}` block, matched by counting braces. */
function layerBlocks(css: string, name: string): string[] {
  const blocks: string[] = [];
  const opener = `@layer ${name} {`;
  let from = 0;
  for (;;) {
    const start = css.indexOf(opener, from);
    if (start === -1) return blocks;
    let depth = 0;
    let i = start + opener.length - 1;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) break;
    }
    blocks.push(css.slice(start + opener.length, i));
    from = i;
  }
}

describe('the theme crossfade is a default, not an override', () => {
  it('declares the theme transition inside @layer base', () => {
    const base = layerBlocks(APP_CSS, 'base');
    expect(base.length).toBeGreaterThan(0);
    const holder = base.find((block) => block.includes('.theme-transition'));
    expect(holder, 'the theme-transition rule is inside @layer base').toBeDefined();
    expect(holder).toContain('background-color 180ms ease');
    // The element selectors are the reason it matters: they name the tags Tailwind utilities are
    // written on most often.
    const selectors = (holder ?? '')
      .slice(0, (holder ?? '').indexOf('{'))
      .split(',')
      .map((one) => one.trim());
    for (const tag of ['nav', 'aside', 'header', 'button', 'input', 'textarea', 'select']) {
      expect(selectors, tag).toContain(tag);
    }
  });

  it('leaves no unlayered copy of it behind', () => {
    const base = layerBlocks(APP_CSS, 'base');
    const inside = base.reduce((n, block) => n + block.split('.theme-transition').length - 1, 0);
    const total = APP_CSS.split('.theme-transition').length - 1;
    // Every mention of the class is inside the layer. A second, unlayered copy would win again and
    // the computed value would be exactly what it was before.
    expect(total).toBe(inside);
  });
});
