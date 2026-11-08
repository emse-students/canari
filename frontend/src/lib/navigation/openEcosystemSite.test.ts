// @vitest-environment happy-dom
/**
 * THE ONE OPENER OF THE SIBLING SITES (docs/wiki/sessions.md, "The sign-in handoff"). Pinned: a
 * site whose handoff flag is on mints and opens the URL the server composed; one without the flag
 * opens plainly and mints nothing; a refused or failed mint opens plainly and says so at warn with
 * its class, except the estate's configured "not offered" state, said once at info; on the web the
 * tab is opened before the request and cut from its opener; and no registered origin is opened by
 * any other module of the app.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openUrl = vi.fn(async (_url: string) => {});
const apiFetch = vi.fn();
const sites = vi.hoisted(() => ({
  list: [
    { id: 'migallery', href: 'https://gallery.mitv.fr', handoff: true },
    { id: 'le-cercle', href: 'https://cercle.emse.fr', handoff: false },
  ] as Array<{ id: string; href: string; handoff: boolean }>,
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (url: string) => openUrl(url) }));
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://canari.example' }));
vi.mock('$lib/utils/Log', () => ({ Log: { d: vi.fn(), i: vi.fn() } }));
vi.mock('$lib/navigation/ecosystemSites', () => ({ ECOSYSTEM_SITES: sites.list }));

const { openEcosystemSite, resetEcosystemSiteForTests, plainSiteUrl } =
  await import('./openEcosystemSite');
const { Log } = await import('$lib/utils/Log');

const MINTED = 'https://gallery.mitv.fr/auth/handoff#eyJ.header.sig';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('openEcosystemSite', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetEcosystemSiteForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    delete (window as TauriWindow).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    openUrl.mockClear();
    apiFetch.mockReset();
  });

  describe('on the native shells', () => {
    beforeEach(() => {
      (window as TauriWindow).__TAURI_INTERNALS__ = {};
    });

    it('mints, then opens the URL the server composed in the system browser', async () => {
      apiFetch.mockResolvedValue(json(200, { url: MINTED, expiresInSeconds: 60 }));
      openEcosystemSite('migallery', '/mes-photos');
      await settle();
      const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://canari.example/api/auth/handoff');
      expect(JSON.parse(String(init.body))).toEqual({ aud: 'migallery', dest: '/mes-photos' });
      expect(openUrl).toHaveBeenCalledWith(MINTED);
      expect(warn).not.toHaveBeenCalled();
    });

    it('opens a site without the flag plainly, minting nothing', async () => {
      openEcosystemSite('le-cercle');
      await settle();
      expect(apiFetch).not.toHaveBeenCalled();
      expect(openUrl).toHaveBeenCalledWith('https://cercle.emse.fr');
    });

    it('opens plainly on a refused mint, said at warn with the class', async () => {
      apiFetch.mockResolvedValue(json(400, { code: 'HANDOFF_SITE_NOT_ENABLED' }));
      openEcosystemSite('migallery', '/mes-photos');
      await settle();
      expect(openUrl).toHaveBeenCalledWith('https://gallery.mitv.fr/mes-photos');
      expect(String(warn.mock.calls[0][0])).toContain('class=HANDOFF_SITE_NOT_ENABLED (400)');
    });

    it('opens plainly on a transport failure, said at warn with the class', async () => {
      apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
      openEcosystemSite('migallery');
      await settle();
      expect(openUrl).toHaveBeenCalledWith('https://gallery.mitv.fr');
      expect(String(warn.mock.calls[0][0])).toContain('class=TypeError');
    });

    it('refuses a minted URL that is not on the site, and opens plainly', async () => {
      apiFetch.mockResolvedValue(json(200, { url: 'https://evil.example/auth/handoff#x' }));
      openEcosystemSite('migallery');
      await settle();
      expect(openUrl).toHaveBeenCalledWith('https://gallery.mitv.fr');
      expect(openUrl).not.toHaveBeenCalledWith('https://evil.example/auth/handoff#x');
      expect(String(warn.mock.calls[0][0])).toContain('class=HandoffUrlMismatchError');
    });

    it('says an estate without the handoff once, at info, and never at warn', async () => {
      apiFetch.mockImplementation(async () => json(404, { code: 'HANDOFF_NOT_OFFERED' }));
      openEcosystemSite('migallery');
      await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));
      openEcosystemSite('migallery');
      await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(2));
      expect(warn).not.toHaveBeenCalled();
      const said = vi
        .mocked(Log.i)
        .mock.calls.filter(([, line]) => String(line).includes('no sign-in handoff'));
      expect(said).toHaveLength(1);
    });
  });

  describe('on the web', () => {
    it('opens the tab in the click, cuts the opener, then points it at the minted URL', async () => {
      let resolveMint: (r: Response) => void = () => {};
      apiFetch.mockReturnValue(new Promise<Response>((r) => (resolveMint = r)));
      const tab = { opener: {} as unknown, closed: false, location: { href: 'about:blank' } };
      const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
      openEcosystemSite('migallery', '/mes-photos');
      // Synchronously, before any answer: the popup rule wants the open inside the gesture.
      expect(open).toHaveBeenCalledWith('about:blank', '_blank');
      expect(tab.opener).toBeNull();
      resolveMint(json(200, { url: MINTED }));
      await settle();
      expect(tab.location.href).toBe(MINTED);
    });

    it('points the tab at the plain address when the mint fails', async () => {
      apiFetch.mockResolvedValue(json(503, {}));
      const tab = { opener: null, closed: false, location: { href: 'about:blank' } };
      vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
      openEcosystemSite('migallery', '/mes-photos');
      await settle();
      expect(tab.location.href).toBe('https://gallery.mitv.fr/mes-photos');
      expect(String(warn.mock.calls[0][0])).toContain('class=uncoded (503)');
    });

    it('mints nothing when a popup rule blocks the tab, and never replaces Canari', async () => {
      vi.spyOn(window, 'open').mockReturnValue(null);
      openEcosystemSite('migallery');
      await settle();
      expect(apiFetch).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toContain('blocked by a popup rule');
    });

    it('opens a site without the flag in a new tab, plainly', () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      openEcosystemSite('le-cercle');
      expect(open).toHaveBeenCalledWith('https://cercle.emse.fr', '_blank', 'noopener');
      expect(apiFetch).not.toHaveBeenCalled();
    });
  });

  it('writes a plain address from the origin and the path', () => {
    const site = { id: 'migallery', href: 'https://gallery.mitv.fr', handoff: true } as never;
    expect(plainSiteUrl(site, '/')).toBe('https://gallery.mitv.fr');
    expect(plainSiteUrl(site, '/mes-photos')).toBe('https://gallery.mitv.fr/mes-photos');
  });
});

/**
 * A REGISTERED ORIGIN IS OPENED THROUGH THE OPENER, OR NOT AT ALL. A second module writing
 * `https://gallery.mitv.fr` (or Sky's, or Le Cercle's) would open it without the handoff - or,
 * worse, mint for a link someone else wrote. The site list is the only place an origin is written;
 * the link-preview tables name bare hosts, never an address to open.
 */
describe('no module but the site list writes a sibling origin', () => {
  const contract = JSON.parse(
    readFileSync(resolve('..', 'libs', 'contracts', 'ecosystem-sites.json'), 'utf8')
  ) as { sites: Array<{ origin: string }> };
  const allowed = new Set(['src/lib/navigation/ecosystemSites.ts']);

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'paraglide' ? [] : walk(path);
      return /\.(ts|svelte)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
    });

  it('finds every origin only in ecosystemSites.ts', () => {
    const offenders: string[] = [];
    for (const file of walk(resolve('src'))) {
      const rel = relative(resolve('.'), file).replace(/\\/g, '/');
      if (allowed.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      for (const { origin } of contract.sites) {
        if (text.includes(origin)) offenders.push(`${rel}: ${origin}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
