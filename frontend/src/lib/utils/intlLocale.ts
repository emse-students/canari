import { getLocale } from '$lib/paraglide/runtime';

/**
 * The `Intl` locale this client formats dates, times and amounts in - the ONE place a region tag
 * is chosen.
 *
 * `getLocale()` answers `'fr'` / `'en'`, which `Intl` accepts but resolves to defaults of its own
 * for the second; the two region tags are named here so a date reads the same on every surface.
 * A formatter never names a tag itself: `intlLocale.guard.test.ts` reads the sources for one.
 */
export function intlLocale(): string {
  return getLocale() === 'en' ? 'en-US' : 'fr-FR';
}
