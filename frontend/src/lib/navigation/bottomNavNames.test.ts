import { afterAll, describe, expect, it } from 'vitest';

import { APP_PLACES, resolveActivePlaceId } from '$lib/navigation/places';
import { getLocale, locales, overwriteGetLocale } from '$lib/paraglide/runtime';

/**
 * A BAR THAT DRAWS NO TEXT HAS EXACTLY ONE NAME PER TAB, AND NOTHING ON SCREEN WOULD SHOW IT MISSING.
 *
 * This file replaced `bottomNavLabels.test.ts`, which held a character budget: a cell is 90px at
 * 360px, "Tableau de bord" needed 90.2px bold, so a drawn name had to be at most twelve characters.
 * The bar stopped drawing names on 2026-09-14 - Instagram, read on A1 (Mi 9T) the same day, carries
 * a `content-desc` on each of its five tabs and not one `TextView` - so that budget now constrains
 * nothing and `shortLabel` went with it.
 *
 * What replaced it is a HARDER thing to notice by looking. The visible label used to be the tab's
 * accessible name; now `sr-only` text is, and an empty one is invisible on every screen and silent
 * in every review. A tab with no name is a tab a screen reader announces as its URL.
 */
const realLocale = getLocale();
afterAll(() => overwriteGetLocale(() => realLocale));

/** Reads a place's name as a given locale, the way a client with that locale would. */
function asLocale<T>(locale: (typeof locales)[number], read: () => T): T {
  overwriteGetLocale(() => locale);
  try {
    return read();
  } finally {
    overwriteGetLocale(() => realLocale);
  }
}

describe('every tab the bottom bar draws has a name it does not show', () => {
  const drawn = APP_PLACES.filter((place) => place.mobileNav);

  it('draws four places, in the order the bar reads left to right', () => {
    expect(drawn.map((p) => p.id)).toEqual(['posts', 'communities', 'chat', 'dashboard']);
  });

  it.each(drawn.flatMap((place) => locales.map((locale) => [place.id, locale] as const)))(
    '%s is named in %s',
    (id, locale) => {
      const place = APP_PLACES.find((p) => p.id === id);
      expect(asLocale(locale, () => place!.label()).trim()).not.toBe('');
    }
  );

  it('the name is the FULL one now that no cell has to hold it', () => {
    expect(asLocale('fr', () => APP_PLACES.find((p) => p.id === 'dashboard')!.label())).toBe(
      'Tableau de bord'
    );
  });

  it('every place has a name, drawn here or not', () => {
    for (const place of APP_PLACES) {
      for (const locale of locales) {
        expect(asLocale(locale, () => place.label()).trim()).not.toBe('');
      }
    }
  });

  it('each drawn place claims its own href, so exactly one tab is ever active', () => {
    for (const place of drawn) {
      expect(resolveActivePlaceId(place.href)).toBe(place.id);
    }
  });
});
