/**
 * NOBODY WRITES A PAGE COLUMN BY HAND, AND THIS IS THE HALF `pageWidth.test.ts` SAID IT COULD NOT
 * SEE.
 *
 * That file's own docblock names the hole: *"a fourth entry here, or a `max-w-*` written at a call
 * site, both compile and both look reasonable in the diff that adds them"* - and then closes only
 * the first of the two. Five pages were carrying the second on 2026-09-14, three of them widths that
 * appear in no scale:
 *
 * | Where | What it wrote | Why the 52-route sweep missed it |
 * | --- | --- | --- |
 * | `AssociationDetailView` | `mx-auto max-w-4xl` = 896px | it is a COMPONENT; `/associations/[slug]` and `/lists/[slug]` are eight-line files that render it, so the width sat one level below everything the sweep read |
 * | `forms/[id]` | `mx-auto max-w-2xl` = 672px | eight pixels off the reading measure - close enough to look right in every screenshot |
 * | `c/join/[token]`, `g/join/[token]` | `mx-auto max-w-md` = 448px | two byte-identical files, and neither looked like a page |
 *
 * **A COUNT OF ROUTES IS NOT A COUNT OF PAGE COLUMNS**, which is the same shape as this repository's
 * standing rule that a count of call sites is not a count of implementations. The 2026-09-10 sweep
 * measured 52 routes and was right about all 52; the widths it was hunting were living in the files
 * it did not have to open.
 *
 * ## The line, and why it is 640px rather than a list of files
 *
 * A centred box is only a page column when it is wide enough to BE one. `pageWidth.ts` declares the
 * narrowest page shape at 680px (`reading`), and the nearest Tailwind step below that is `max-w-2xl`
 * at 672 - which is exactly what `forms/[id]` had. So the rule is a number: **`mx-auto` together
 * with a max-width of 640px or more is a page column**, whatever the file calls it, and it belongs
 * to `PageContainer`.
 *
 * Below the line nothing is asserted, deliberately. The join cards keep `mx-auto max-w-md`: 448px is
 * a CARD measurement - a one-decision interstitial should not run the width of a catalogue - and it
 * is now written on the card, inside a `PageContainer`, rather than on the page. An exemption list
 * would have had to name those two files, and this repository has already paid for the guard that
 * named the two files it had been burnt by: three more occurrences followed, outside it.
 *
 * ## It reads the class attribute, not the line
 *
 * Whitespace is collapsed across the whole file before anything is matched, because a class
 * attribute that spans lines is how a scan misses one. That is not hypothetical here: the overlay
 * sweep on 2026-09-13 left two components unclassified for precisely that reason, and the note
 * beside them had to say the root was never read.
 */
import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allMarkup } from '$lib/styles/markupSources';
import { PAGE_WIDTHS } from './pageWidth';

/**
 * The Tailwind `max-w-*` steps, in pixels.
 *
 * Only the steps at or above the line need a value - everything narrower is allowed and never
 * compared - but the ones just below it are listed too, so that a step moving across the boundary is
 * a visible edit here rather than a silent pass.
 */
const MAX_W_STEPS: Record<string, number> = {
  'max-w-xs': 320,
  'max-w-sm': 384,
  'max-w-md': 448,
  'max-w-lg': 512,
  'max-w-xl': 576,
  'max-w-2xl': 672,
  'max-w-3xl': 768,
  'max-w-4xl': 896,
  'max-w-5xl': 1024,
  'max-w-6xl': 1152,
  'max-w-7xl': 1280,
};

/**
 * The width a page column has to reach before it counts as one: 640px.
 *
 * `reading` is 680 and the Tailwind step below it is 672, so anything from `2xl` up is competing
 * with the page column rather than sitting inside it.
 */
const PAGE_COLUMN_PX = 640;

/** Every `class="..."` value in `body`, with whitespace collapsed so a wrapped attribute is one. */
function classAttributes(body: string): string[] {
  const flat = body.replace(/\s+/g, ' ');
  const out: string[] = [];
  const attr = /class="([^"]*)"/g;
  let m = attr.exec(flat);
  while (m !== null) {
    out.push(m[1]);
    m = attr.exec(flat);
  }
  return out;
}

/**
 * The width this class attribute centres itself at, or `null` if it centres nothing.
 *
 * A `max-w-[Nrem]` is read as a number; a named step is looked up. A step this file does not know
 * THROWS rather than passing, for the same reason `pageWidth.test.ts` throws on an unknown utility:
 * a gate that silently ignores what it cannot parse is a gate that stops holding the moment someone
 * reaches for a step nobody listed.
 */
function centredWidthOf(classes: string): number | null {
  const tokens = classes.split(' ');
  if (!tokens.includes('mx-auto')) return null;

  for (const token of tokens) {
    if (!token.startsWith('max-w-')) continue;
    // An arbitrary value states its own size.
    const rem = /^max-w-\[([\d.]+)rem]$/.exec(token);
    if (rem) return Number(rem[1]) * 16;
    if (token.startsWith('max-w-[')) continue; // a px/ch/% arbitrary value is not a page column shape
    if (token === 'max-w-full' || token === 'max-w-none' || token === 'max-w-screen') continue;
    const px = MAX_W_STEPS[token];
    if (px === undefined) {
      throw new Error(
        `${token} is a max-width step this gate does not know. Add it to MAX_W_STEPS WITH its ` +
          'pixel size, so the page-column rule keeps meaning something.'
      );
    }
    return px;
  }
  return null;
}

// The same spelling every other markup gate uses: `src` is three levels up from a file in
// `lib/components/layout`, resolved from the module's own URL rather than from a cwd.
const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('the page column', () => {
  it('is never written by hand: no markup centres itself at a page width', () => {
    const offenders = allMarkup(src)
      .flatMap(({ file, body }) =>
        classAttributes(body).map((classes) => ({ file, classes, px: centredWidthOf(classes) }))
      )
      .filter(({ px }) => px !== null && px >= PAGE_COLUMN_PX)
      .map(({ file, classes, px }) => `${file}: ${px}px in "${classes.slice(0, 90)}"`);

    expect(
      offenders,
      'A centred box this wide IS the page column, and the page column is PageContainer. ' +
        'Pick one of the three shapes in pageWidth.ts; if the page seems to be none of them, ' +
        'that is a question about the page rather than a reason for a fourth number.'
    ).toEqual([]);
  });

  it('draws the line just under the narrowest page shape, so nothing can sit beside it', () => {
    // 680px is `reading`, the narrowest thing PageContainer will draw. The line has to be BELOW it,
    // or the step that got `forms/[id]` to 672 passes again.
    const reading = Number(/^max-w-\[([\d.]+)rem]$/.exec(PAGE_WIDTHS.reading)?.[1]) * 16;

    expect(reading).toBeGreaterThan(PAGE_COLUMN_PX);
    expect(MAX_W_STEPS['max-w-2xl']).toBeGreaterThan(PAGE_COLUMN_PX);
    expect(MAX_W_STEPS['max-w-xl']).toBeLessThan(PAGE_COLUMN_PX);
  });

  it('can see a page column when it is handed one, wrapped across lines like a real file', () => {
    // A predicate never shown a positive is a predicate nobody has tested - and the wrapping is the
    // half that matters, because a class attribute broken over three lines is how the last sweep
    // left two components unread.
    const planted = ['<div', '  class="mx-auto max-w-4xl', '    space-y-8 px-4"', '>'].join('\n');

    expect(classAttributes(planted)).toHaveLength(1);
    expect(centredWidthOf(classAttributes(planted)[0])).toBe(896);
  });

  it('leaves a narrow centred card alone, which is why there is no exemption list', () => {
    expect(centredWidthOf('border-cn-border mx-auto max-w-md rounded-2xl p-8')).toBe(448);
    expect(centredWidthOf('max-w-4xl space-y-8')).toBeNull();
  });
});
