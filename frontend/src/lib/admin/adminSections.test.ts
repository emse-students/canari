/**
 * THE HUB AND THE GUARD READ ONE TABLE: a page a tier cannot open is neither LISTED nor REACHABLE.
 */
import { describe, expect, it } from 'vitest';
import { adminHubGroups, adminTrail, mayOpenAdminPath, type AdminTiers } from './adminSections';
import { parseTab, tabUrl } from './tabQuery';

const NONE: AdminTiers = {
  isGlobalAdmin: false,
  isSuperAdmin: false,
  isModerator: false,
  isEventValidator: false,
};
const GLOBAL: AdminTiers = {
  isGlobalAdmin: true,
  isSuperAdmin: true,
  isModerator: true,
  isEventValidator: true,
};

/** Every admin page the app has, as the filesystem names them. */
const ADMIN_PAGES = [
  'agenda',
  'carte',
  'cercle',
  'database',
  'legacy-cotisations',
  'moderation',
  'platform',
  'profile-corrections',
  'read-access',
  'spaces',
  'status',
  'storage',
  'users',
].map((p) => `/admin/${p}`);

const TIERS: Record<string, AdminTiers> = {
  none: NONE,
  validator: { ...NONE, isEventValidator: true },
  moderator: { ...NONE, isModerator: true },
  superAdmin: { ...NONE, isSuperAdmin: true },
  global: GLOBAL,
};

const listed = (t: AdminTiers) =>
  new Set(
    adminHubGroups(t)
      .flatMap((g) => g.rows)
      .map((r) => r.href)
  );

describe('admin sections', () => {
  for (const [name, tiers] of Object.entries(TIERS)) {
    it(`${name}: a listed page opens and an unlisted one does not`, () => {
      const rows = listed(tiers);
      for (const page of ADMIN_PAGES) {
        expect(mayOpenAdminPath(page, tiers), `${name} ${page}`).toBe(rows.has(page));
      }
    });
  }

  it('lists exactly the pages the old strip showed per tier', () => {
    const admin = (t: AdminTiers) => [...listed(t)].filter((h) => h.startsWith('/admin/')).sort();
    expect(admin(NONE)).toEqual([]);
    expect(admin(TIERS.validator)).toEqual(['/admin/agenda']);
    expect(admin(TIERS.moderator)).toEqual(['/admin/moderation']);
    expect(admin(TIERS.superAdmin)).toEqual(['/admin/carte', '/admin/read-access']);
    expect(admin(GLOBAL)).toEqual([...ADMIN_PAGES].sort());
  });

  it('refuses what a tier cannot open, below the page too, and an unknown path', () => {
    expect(mayOpenAdminPath('/admin/users', TIERS.moderator)).toBe(false);
    expect(mayOpenAdminPath('/admin/carte/abc', TIERS.moderator)).toBe(false);
    expect(mayOpenAdminPath('/admin/carte/abc', TIERS.superAdmin)).toBe(true);
    expect(mayOpenAdminPath('/admin/users-and-more', GLOBAL)).toBe(false);
    expect(mayOpenAdminPath('/admin/nope', GLOBAL)).toBe(false);
  });

  it('opens the hub to anyone the layout admitted', () => {
    expect(mayOpenAdminPath('/admin', NONE)).toBe(true);
  });

  it('draws no empty group', () => {
    for (const tiers of Object.values(TIERS)) {
      for (const g of adminHubGroups(tiers)) expect(g.rows.length).toBeGreaterThan(0);
    }
  });

  it('builds Admin > Group > Page with every crumb a link, and one more below the carte', () => {
    const trail = adminTrail('/admin/moderation', 'Admin')!;
    expect(trail.map((c) => c.href)).toEqual([
      '/admin',
      '/admin#group-moderation',
      '/admin/moderation',
    ]);
    expect(adminTrail('/admin/carte/42', 'Admin')).toHaveLength(4);
    expect(adminTrail('/admin', 'Admin')).toBeUndefined();
  });
});

describe('tab query', () => {
  const TABS = ['a', 'b', 'c'] as const;
  it('falls back on anything unknown', () => {
    expect(parseTab('b', TABS, 'a')).toBe('b');
    expect(parseTab('zzz', TABS, 'a')).toBe('a');
    expect(parseTab(null, TABS, 'a')).toBe('a');
  });
  it('keeps the bare path for the default and the other parameters otherwise', () => {
    const url = new URL('https://x.test/admin/moderation?q=1#top');
    expect(tabUrl(url, 'b', 'a')).toBe('/admin/moderation?q=1&tab=b#top');
    expect(tabUrl(new URL('https://x.test/admin/moderation?tab=b'), 'a', 'a')).toBe(
      '/admin/moderation'
    );
  });
});
