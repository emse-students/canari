import { afterAll, describe, expect, it } from 'vitest';

import { APP_PLACES } from '$lib/navigation/places';
import { getLocale, locales, overwriteGetLocale } from '$lib/paraglide/runtime';

/**
 * A NAME THE BOTTOM BAR CANNOT DRAW IS A NAME THE BOTTOM BAR MUST NOT BE GIVEN.
 *
 * Measured on the local estate at the `--text-2xs` floor (12px, and `app.css` says nothing goes
 * below it), against the app's own compiled CSS, on 2026-09-14:
 *
 * | label | width, BOLD |
 * | --- | --- |
 * | Feed | 26.8px |
 * | Discussions | 65.2px |
 * | Communautes | 80.1px |
 * | Tableau de bord | **90.2px** |
 *
 * The bar splits the window into four, so a cell is `width / 4`: 97.5px at 390px, 93.8px at 375,
 * and **90px at 360** - one of the commonest Android widths. "Tableau de bord" therefore did not
 * fit, and it only stopped fitting WHEN SELECTED: the active state goes from weight 500 to 700 and
 * bold text is wider, so choosing a tab was what clipped its own name to "Tableau de bo...".
 *
 * THE BUDGET IS IN CHARACTERS BECAUSE A TEST CANNOT MEASURE TEXT. happy-dom lays nothing out, so
 * this converts at the rate the measurement above gives: 90.2px over 15 characters is 6.01px each,
 * and the widest sample ("Feed", 26.8 over 4) is 6.70px. At the pessimistic rate, twelve characters
 * are 80.4px against a 360px cell of 90px, which leaves the widest string that can pass here 9.6px
 * of room. Nothing may raise this number without a new measurement written beside it.
 */
const MAX_CHARS = 12;

/** The narrowest window the bar is measured against; see the budget above. */
const NARROWEST_SUPPORTED_WIDTH = 360;

const realLocale = getLocale();
afterAll(() => overwriteGetLocale(() => realLocale));

/** Reads a place's names as a given locale, the way a client with that locale would. */
function asLocale<T>(locale: (typeof locales)[number], read: () => T): T {
  overwriteGetLocale(() => locale);
  try {
    return read();
  } finally {
    overwriteGetLocale(() => realLocale);
  }
}

describe('the bottom bar can draw every name it is given', () => {
  const drawn = APP_PLACES.filter((place) => place.mobileNav);

  it('draws four places, so a cell is a quarter of the window', () => {
    expect(drawn.map((p) => p.id)).toEqual(['posts', 'communities', 'chat', 'dashboard']);
    expect(NARROWEST_SUPPORTED_WIDTH / drawn.length).toBe(90);
  });

  it.each(drawn.flatMap((place) => locales.map((locale) => [place.id, locale] as const)))(
    '%s fits in %s',
    (id, locale) => {
      const place = APP_PLACES.find((p) => p.id === id);
      const label = asLocale(locale, () => place!.shortLabel());
      expect(label.trim()).not.toBe('');
      expect(label.length).toBeLessThanOrEqual(MAX_CHARS);
    }
  );

  it('the one that did not fit is the one that got a shorter name', () => {
    const dashboard = APP_PLACES.find((p) => p.id === 'dashboard')!;
    const [long, short] = asLocale('fr', () => [dashboard.label(), dashboard.shortLabel()]);
    expect(long).toBe('Tableau de bord');
    expect(short).toBe('Tableau');
    expect(long.length).toBeGreaterThan(MAX_CHARS);
  });

  it('every place has a short name, drawn here or not', () => {
    for (const place of APP_PLACES) {
      for (const locale of locales) {
        expect(asLocale(locale, () => place.shortLabel()).trim()).not.toBe('');
      }
    }
  });
});
