/// <reference types="jest" />

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  destIsAllowed,
  ECOSYSTEM_SITES,
  HANDOFF_LANDING_PATH,
  HandoffRefusal,
  handoffSite,
} from './handoff-sites';

/**
 * The registry is the contract's, entry for entry: the frontend asserts the same file, so the id a
 * client names and the origin this service composes cannot drift apart.
 */
describe('the handoff registry', () => {
  const contract = JSON.parse(
    readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', 'libs', 'contracts', 'ecosystem-sites.json'),
      'utf8'
    )
  ) as {
    sites: unknown[];
    landingPath: string;
    refusals: Record<string, string>;
  };

  it('equals libs/contracts/ecosystem-sites.json', () => {
    expect(ECOSYSTEM_SITES).toEqual(contract.sites);
    expect(HANDOFF_LANDING_PATH).toBe(contract.landingPath);
    expect(HandoffRefusal).toEqual(contract.refusals);
  });

  it('holds only https origins, and no handoff for a site outside MiConnect', () => {
    for (const site of ECOSYSTEM_SITES) {
      expect(new URL(site.origin).protocol).toBe('https:');
      expect(new URL(site.origin).origin).toBe(site.origin);
      expect([site.id, site.miconnect || !site.handoff]).toEqual([site.id, true]);
    }
  });

  it('refuses an unknown site, a non-MiConnect site, and a site whose flag is off', () => {
    expect(handoffSite('evil')).toEqual({ refusal: HandoffRefusal.unknownSite });
    expect(handoffSite(undefined)).toEqual({ refusal: HandoffRefusal.unknownSite });
    expect(handoffSite('portail-etu')).toEqual({ refusal: HandoffRefusal.unknownSite });
    expect(handoffSite('migallery', [{ ...ECOSYSTEM_SITES[0], handoff: false }])).toEqual({
      refusal: HandoffRefusal.siteNotEnabled,
    });
    const on = { ...ECOSYSTEM_SITES[0], handoff: true };
    expect(handoffSite('migallery', [on])).toEqual({ site: on });
  });

  it('matches a dest against the allowlist exactly, segment by segment', () => {
    const allowed = ['/', '/mes-photos', '/albums/{uuid}'];
    expect(destIsAllowed('/', allowed)).toBe(true);
    expect(destIsAllowed('/mes-photos', allowed)).toBe(true);
    expect(destIsAllowed('/albums/0b8e6f9a-1c2d-4e3f-8a9b-0c1d2e3f4a5b', allowed)).toBe(true);
    for (const refused of [
      '',
      'mes-photos',
      '/mes-photos/',
      '/mes-photos?x=1',
      '/mes-photos#x',
      '//evil.example',
      'https://evil.example/',
      '/albums/../admin',
      '/albums/0B8E6F9A-1C2D-4E3F-8A9B-0C1D2E3F4A5B',
      '/albums/not-a-uuid',
      '/albums/0b8e6f9a-1c2d-4e3f-8a9b-0c1d2e3f4a5b/edit',
      '/admin',
    ]) {
      expect([refused, destIsAllowed(refused, allowed)]).toEqual([refused, false]);
    }
  });
});
