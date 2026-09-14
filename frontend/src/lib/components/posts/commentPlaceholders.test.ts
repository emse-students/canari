import { afterAll, describe, expect, it } from 'vitest';

import { m } from '$lib/paraglide/messages';
import { getLocale, locales, overwriteGetLocale } from '$lib/paraglide/runtime';

/**
 * A PLACEHOLDER IS THE ONE PIECE OF TEXT WITH NOTHING TO TAP THROUGH TO, AND IT IS CLIPPED LIKE
 * ANY OTHER - so the comment box's invitation has to fit the box before it is written.
 *
 * The editor inside the composer pill is the row's only flexible child, and everything beside it
 * is fixed: a 24px avatar, a 10px gap, 14px of pill padding either side, the 44px send target and
 * its 4px margin, plus the card's own padding. Measured on the local estate at five widths on
 * 2026-09-14, the relation is exactly linear - the editor gets `viewport - 184px`:
 *
 * | viewport | the editor's width |
 * | --- | --- |
 * | 430 | 246px |
 * | 390 | 206px |
 * | 375 | **191px** |
 * | 360 | 176px |
 * | 320 | 136px |
 *
 * **THE BUDGET IS 191px, AT THE 375px REFERENCE THIS PAGE MEASURES EVERYTHING AGAINST** (section
 * 17). Against it, the French "Soyez le premier a commenter..." wanted 215px and was cut on every
 * phone - by 9px at 390, by 39px at 360 - on the box every post with no comments shows. The
 * layout cannot pay for it: trimming the pill's padding and the row's gap to their next step down
 * returns 6px of the 24 needed at the reference, and the 44px send target is a floor.
 *
 * **THE BUDGET IS IN CHARACTERS BECAUSE A TEST CANNOT MEASURE TEXT** - happy-dom lays nothing out,
 * so the same conversion section 19 makes is made here. **Its rule does not transfer, and that is
 * worth knowing**: section 19 takes the widest per-character rate of any sample, which here is
 * "Add a comment..." at 8.44px - 14 characters in which one ellipsis and one capital dominate.
 * Applied, that rate forbids "Ajouter un commentaire..." (23 characters, measured 173.6px), which
 * demonstrably fits with 17px to spare. **Take the rate from the strings long enough for the cap
 * to bind**: among the samples of 20 characters or more the widest is 7.55px each, and 191px over
 * 7.55 is 25.3. Hence 25, which leaves the longest string that can pass here 2px of room.
 *
 * Nothing may raise this number without a new measurement written beside it.
 */
const MAX_CHARS = 25;

/** The reference width the budget above is taken at; see section 17 of the design reference. */
const REFERENCE_WIDTH = 375;

/** What everything other than the editor spends on that row, measured; see the table above. */
const FIXED_COST = 184;

const realLocale = getLocale();
afterAll(() => overwriteGetLocale(() => realLocale));

/** Reads a message as a given locale, the way a client with that locale would. */
function asLocale(locale: (typeof locales)[number], read: () => string): string {
  overwriteGetLocale(() => locale);
  try {
    return read();
  } finally {
    overwriteGetLocale(() => realLocale);
  }
}

/** The three placeholders the comment composer can be given, by the name they are chosen under. */
const PLACEHOLDERS = [
  ['first comment', () => m.post_first_comment_placeholder()],
  ['further comment', () => m.post_comment_placeholder()],
  ['reply', () => m.post_reply_placeholder()],
] as const;

describe('the comment box can print every invitation it is given', () => {
  it('the budget is the editor width at the reference, not a guess', () => {
    expect(REFERENCE_WIDTH - FIXED_COST).toBe(191);
  });

  it.each(PLACEHOLDERS.flatMap(([name, read]) => locales.map((l) => [name, l, read] as const)))(
    'the %s placeholder fits in %s',
    (_name, locale, read) => {
      const text = asLocale(locale, read);
      expect(text.trim()).not.toBe('');
      expect(text.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  );

  it('the one that did not fit is the one that was shortened', () => {
    expect(asLocale('fr', () => m.post_first_comment_placeholder())).toBe('Soyez le premier\u2026');
    expect('Soyez le premier \u00e0 commenter\u2026'.length).toBeGreaterThan(MAX_CHARS);
  });
});
