/**
 * A STICKY ASIDE PINS AT THE SAME DISTANCE ITS COLUMN STARTS AT, OR IT MOVES BY THE DIFFERENCE.
 *
 * `PageContainer`'s row was `py-6 md:py-8`; the feed's conversations panel was `sticky top-4`.
 * Two numbers for one distance. Measured on the live estate, 2026-09-22, at 1920x945 with the
 * panel at its full height:
 *
 * | `scrollTop` | panel y | feed y | gap |
 * | --- | --- | --- | --- |
 * | 0 | 105 | 105 | 0 |
 * | 8 | 97 | 97 | 0 |
 * | 16 | 89 | 89 | 0 |
 * | 24 | 89 | 81 | **8** |
 * | 32 | 89 | 73 | **16** |
 *
 * The panel tracks its column perfectly until `scrollTop` reaches the sticky offset, then locks -
 * so it travels `padding-top - top` = 32 - 16 = 16px up its own column, once, on every scroll from
 * the top of the page. Nothing else on the page moves relative to anything, which is why a 16px
 * slide reads as a defect rather than as motion.
 *
 * WHAT THIS GATE REFUSES IS THE SHAPE, NOT THE VALUE. Both halves now read `--page-column-top`, and
 * the token carries its own breakpoint step so that a `md:` utility on one half and none on the
 * other - the exact shape of the original defect - cannot be written. Each half is asserted
 * separately: a fix applied to one of them is the way this comes back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutComments } from '$lib/styles/markupSources';

const CONTAINER = 'src/lib/components/layout/PageContainer.svelte';
const PANEL = 'src/lib/components/posts/ConversationsMiniPanel.svelte';
const CSS = 'src/app.css';
const FEED = 'src/routes/posts/+page.svelte';

const read = (path: string) => withoutComments(readFileSync(path, 'utf8'));

describe('the page column and the aside that sticks to it read one number', () => {
  it('declares the token once, with its breakpoint step', () => {
    const css = readFileSync(CSS, 'utf8');
    expect(css.match(/--page-column-top:/g) ?? []).toHaveLength(2);
    expect(css).toContain('--page-column-top: 1.5rem;');
    expect(css).toContain('--page-column-top: 2rem;');
  });

  it('pads the column from the token, and nowhere writes a step beside it', () => {
    const markup = read(CONTAINER);
    expect(markup).toContain('py-(--page-column-top)');
    // A `py-*`/`pt-*` NUMBER on the row is the half that drifts: the token already steps at `md`,
    // so a utility step here would restore two numbers for one distance.
    expect(/(?:^|\s)(?:md:|lg:|xl:)?p[yt]-\d/.test(markup)).toBe(false);
  });

  it('pins the feed panel at the token rather than at a number of its own', () => {
    const markup = read(PANEL);
    expect(markup).toContain('top-(--page-column-top)');
    expect(/(?:^|\s)(?:md:|lg:|xl:)?top-\d/.test(markup)).toBe(false);
  });

  it('starts the feed tab row by cancelling the column top with the token, never a number', () => {
    // The 2026-11-22 report (an iPhone without Liquid Glass, an app before 1.6.9): nothing cancelled
    // the column's top padding, so the tab pill sat 32 px under the opaque header. Cancelled with a
    // raw `-mt-6`, it is right only while the token says 1.5rem.
    const markup = read(FEED);
    expect(markup).toContain('-mt-(--page-column-top)');
    expect(/(?:^|\s|')(?:md:|lg:|xl:)?-mt-\d/.test(markup)).toBe(false);
  });
});

describe('the no-glass path changes the paint of the chrome, never its geometry', () => {
  // WHICH PHONE GETS WHICH CHROME (docs/wiki/frontend/design-reference.md): a WebView without
  // `backdrop-filter`, or a reader asking for less transparency, gets opaque chrome from these two
  // blocks. If either set a length, an opaque bar would keep space sized for a translucent one, or
  // the reverse - the bands of the 2026-11-22 report. Only the `--glass-*` paint variables move.
  const css = readFileSync(CSS, 'utf8');
  const block = (opener: string) => {
    const start = css.indexOf(opener);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
    }
    throw new Error(`unclosed block ${opener}`);
  };
  const declared = (text: string) =>
    [...text.matchAll(/(--[\w-]+|[a-z-]+)\s*:(?!:)[^;{}]*;/g)].map((m) => m[1]);

  it.each([
    '@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))',
    '@media (prefers-reduced-transparency: reduce)',
  ])('%s sets glass paint variables only', (opener) => {
    const names = declared(block(opener));
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((n) => !n.startsWith('--glass-'))).toEqual([]);
  });
});
