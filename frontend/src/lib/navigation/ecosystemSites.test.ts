import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ECOSYSTEM_SITES } from '$lib/navigation/ecosystemSites';
import { locales, overwriteGetLocale, getLocale } from '$lib/paraglide/runtime';

/**
 * THE LAUNCHER'S LINKS LEAVE THE APP, SO NOTHING IN IT WOULD NOTICE ONE GOING BAD. A wrong
 * address, a logo path with a typo or an empty name all render without an error - a broken image,
 * a button opening the wrong place, a tile a screen reader reads as a URL.
 */
describe('the app launcher', () => {
  it('opens MiGallery, Le Cercle, Sky and Portail-etu, in that order', () => {
    expect(ECOSYSTEM_SITES.map((s) => s.id)).toEqual([
      'migallery',
      'le-cercle',
      'sky',
      'portail-etu',
    ]);
  });

  it('equals libs/contracts/ecosystem-sites.json: ids, origins and handoff flags', () => {
    const contract = JSON.parse(
      readFileSync(resolve('..', 'libs', 'contracts', 'ecosystem-sites.json'), 'utf8')
    ) as { sites: Array<{ id: string; origin: string; handoff: boolean }> };
    expect(ECOSYSTEM_SITES.map((s) => ({ id: s.id, origin: s.href, handoff: s.handoff }))).toEqual(
      contract.sites.map((s) => ({ id: s.id, origin: s.origin, handoff: s.handoff }))
    );
  });

  it.each(ECOSYSTEM_SITES.map((s) => [s.id, s.href] as const))(
    '%s links to a bare https origin',
    (_id, href) => {
      const url = new URL(href);
      expect(url.protocol).toBe('https:');
      expect(url.origin).toBe(href);
    }
  );

  it.each(ECOSYSTEM_SITES.map((s) => [s.id, s.logo] as const))(
    '%s draws a logo that is bundled',
    (_id, logo) => {
      expect(existsSync(resolve('static', logo.replace(/^\//, '')))).toBe(true);
    }
  );

  it.each(ECOSYSTEM_SITES.flatMap((s) => locales.map((l) => [s.id, l] as const)))(
    '%s is named in %s',
    (id, locale) => {
      const site = ECOSYSTEM_SITES.find((s) => s.id === id)!;
      const real = getLocale();
      overwriteGetLocale(() => locale);
      try {
        expect(site.label().trim()).not.toBe('');
      } finally {
        overwriteGetLocale(() => real);
      }
    }
  );
});
