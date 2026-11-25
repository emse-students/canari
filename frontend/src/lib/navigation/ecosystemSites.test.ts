import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ECOSYSTEM_SITES,
  ecosystemSiteLink,
  type EcosystemSite,
} from '$lib/navigation/ecosystemSites';
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

  it('equals libs/contracts/ecosystem-sites.json: ids, origins, flags, dests and sign-in entries', () => {
    const contract = JSON.parse(
      readFileSync(resolve('..', 'libs', 'contracts', 'ecosystem-sites.json'), 'utf8')
    ) as {
      sites: Array<{
        id: string;
        origin: string;
        handoff: boolean;
        dests: string[];
        signIn: EcosystemSite['signIn'];
      }>;
    };
    expect(
      ECOSYSTEM_SITES.map((s) => ({
        id: s.id,
        origin: s.href,
        handoff: s.handoff,
        dests: s.dests,
        signIn: s.signIn,
      }))
    ).toEqual(
      contract.sites.map((s) => ({
        id: s.id,
        origin: s.origin,
        handoff: s.handoff,
        dests: s.dests,
        signIn: s.signIn,
      }))
    );
  });

  it('gives every flagged site a sign-in entry to send a person MiConnect must see first', () => {
    for (const site of ECOSYSTEM_SITES.filter((s) => s.handoff)) {
      expect([site.id, site.signIn?.path.startsWith('/')]).toEqual([site.id, true]);
    }
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

/**
 * A LINK SOMEONE ELSE WROTE, ABOUT TO OPEN THE READER'S OWN SESSION. It is handed off only for a
 * flagged site's exact origin and an allowlisted path with nothing else on it; anything else opens
 * as any external link does.
 */
describe('ecosystemSiteLink', () => {
  const sites = [
    {
      id: 'migallery',
      href: 'https://on.example',
      handoff: true,
      dests: ['/', '/mes-photos', '/albums/{uuid}'],
      signIn: { path: '/api/auth/login', returnParam: 'redirectTo' },
    },
    {
      id: 'sky',
      href: 'https://off.example',
      handoff: false,
      dests: ['/'],
      signIn: { path: '/auth/login', returnParam: null },
    },
  ] as unknown as EcosystemSite[];
  const album = '/albums/0b8e6f9a-1c2d-4e3f-8a9b-0c1d2e3f4a5b';

  it.each([
    ['https://on.example', '/'],
    ['https://on.example/', '/'],
    ['https://on.example/mes-photos', '/mes-photos'],
    [`https://on.example${album}`, album],
  ])('hands off %s, landing on %s', (href, dest) => {
    expect(ecosystemSiteLink(href, sites)).toEqual({ site: sites[0], dest });
  });

  it.each([
    // A site whose flag is off, and an origin that only looks like a registered one.
    'https://off.example/',
    'http://on.example/mes-photos',
    'https://on.example:8443/mes-photos',
    'https://on.example.evil.example/mes-photos',
    'https://evil.example/mes-photos',
    // A path outside the allowlist: a state-changing page, a sub-page, a non-UUID album.
    'https://on.example/mes-photos/confirmer',
    'https://on.example/admin/login-as',
    'https://on.example/api/auth/logout',
    `https://on.example${album}/edit`,
    'https://on.example/albums/42',
    // What the handoff could not carry: a query, a fragment, credentials.
    'https://on.example/mes-photos?tab=faces',
    'https://on.example/mes-photos#x',
    'https://user:pw@on.example/mes-photos',
    // Not a URL at all.
    'not a url',
    'mailto:someone@on.example',
  ])('opens %s as any external link', (href) => {
    expect(ecosystemSiteLink(href, sites)).toBeNull();
  });

  it('judges the path the browser would load, so a dot segment cannot climb out of the list', () => {
    expect(ecosystemSiteLink('https://on.example/albums/../admin', sites)).toBeNull();
    expect(ecosystemSiteLink('https://on.example/x/../mes-photos', sites)).toEqual({
      site: sites[0],
      dest: '/mes-photos',
    });
  });
});
