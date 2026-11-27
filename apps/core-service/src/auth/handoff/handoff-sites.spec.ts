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
      // The mint's access check reads the application of every MiConnect site, and of no other.
      expect([site.id, site.miconnect === (site.miconnectApplication !== null)]).toEqual([
        site.id,
        true,
      ]);
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

  it('matches a dest against the allowlist exactly, segment by segment, as the client does', () => {
    // The same cases run against the client's copy (`frontend/.../ecosystemSites.test.ts`).
    const cases = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '..',
          '..',
          '..',
          '..',
          '..',
          'libs',
          'contracts',
          'handoff-dest.cases.json'
        ),
        'utf8'
      )
    ) as { allowlist: string[]; allowed: string[]; refused: string[] };
    expect(cases.allowed.length).toBeGreaterThan(0);
    expect(cases.refused.length).toBeGreaterThan(0);
    for (const ok of cases.allowed) {
      expect([ok, destIsAllowed(ok, cases.allowlist)]).toEqual([ok, true]);
    }
    for (const refused of cases.refused) {
      expect([refused, destIsAllowed(refused, cases.allowlist)]).toEqual([refused, false]);
    }
  });

  it('gives every MiConnect site a sign-in entry, and no other site one', () => {
    for (const site of ECOSYSTEM_SITES) {
      expect([site.id, site.miconnect === (site.signIn !== null)]).toEqual([site.id, true]);
      // A site with no sign-in entry has no path to check: read as `true`, never skipped by a branch.
      expect([site.id, site.signIn?.path.startsWith('/') ?? true]).toEqual([site.id, true]);
    }
  });
});
