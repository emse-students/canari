// @vitest-environment happy-dom
/**
 * THE ONE OPENER OF THE SIBLING SITES (docs/wiki/sessions.md, "The sign-in handoff"). Pinned: a
 * site whose handoff flag is on mints and opens the URL the server composed; one without the flag
 * opens plainly and mints nothing; a refused or failed mint opens plainly and says so at warn with
 * its class, except the estate's configured "not offered" state, said once at info, and a person
 * MiConnect must show a page first (terms, Alumni link, Alumni gate), said at info; on the web the
 * tab is opened before the request and cut from its opener; and no registered origin is opened by
 * any other module of the app.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceFiles } from '../../test/sourceTree';

const openUrl = vi.fn(async (_url: string) => {});
const apiFetch = vi.fn();
const sites = vi.hoisted(() => ({
  list: [
    {
      id: 'migallery',
      href: 'https://gallery.mitv.fr',
      handoff: true,
      dests: ['/', '/mes-photos', '/albums/{uuid}'],
      signIn: { path: '/api/auth/login', returnParam: 'redirectTo' },
    },
    {
      id: 'le-cercle',
      href: 'https://cercle.emse.fr',
      handoff: false,
      dests: ['/'],
      signIn: { path: '/auth/login', returnParam: null },
    },
  ],
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (url: string) => openUrl(url) }));
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
const showToast = vi.fn();
vi.mock('$lib/stores/toast.svelte', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://canari.example' }));
vi.mock('$lib/utils/Log', () => ({ Log: { d: vi.fn(), i: vi.fn() } }));
vi.mock('$lib/navigation/ecosystemSites', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/navigation/ecosystemSites')>();
  return {
    ...real,
    ECOSYSTEM_SITES: sites.list,
    ecosystemSiteLink: (href: string) => real.ecosystemSiteLink(href, sites.list as never),
  };
});

const {
  openEcosystemSite,
  openEcosystemSiteLink,
  resetEcosystemSiteForTests,
  plainSiteUrl,
  signInSiteUrl,
  SETTLED_AT_MICONNECT,
} = await import('./openEcosystemSite');
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
    showToast.mockClear();
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

    it('opens a link tapped three times while it mints ONCE, and again once it settled', async () => {
      let resolveMint!: (r: Response) => void;
      apiFetch.mockReturnValueOnce(new Promise<Response>((r) => (resolveMint = r)));
      openEcosystemSite('migallery', '/mes-photos');
      openEcosystemSite('migallery', '/mes-photos');
      openEcosystemSite('migallery', '/mes-photos');
      expect(apiFetch).toHaveBeenCalledTimes(1);
      // The tap was taken: ONE pending toast, none for the dropped taps.
      expect(showToast).toHaveBeenCalledTimes(1);
      resolveMint(json(200, { url: MINTED }));
      await settle();
      expect(openUrl).toHaveBeenCalledTimes(1);
      apiFetch.mockResolvedValueOnce(json(200, { url: MINTED }));
      openEcosystemSite('migallery', '/mes-photos');
      await settle();
      expect(apiFetch).toHaveBeenCalledTimes(2);
      expect(openUrl).toHaveBeenCalledTimes(2);
    });

    it('keeps the guard until the opener itself has settled', async () => {
      let finishOpen!: () => void;
      openUrl.mockReturnValueOnce(new Promise<void>((r) => (finishOpen = r)));
      apiFetch.mockResolvedValue(json(200, { url: MINTED }));
      openEcosystemSite('migallery', '/mes-photos');
      await settle();
      expect(openUrl).toHaveBeenCalledTimes(1);
      // The browser launch is still pending: a tap now is the same open.
      openEcosystemSite('migallery', '/mes-photos');
      await settle();
      expect(apiFetch).toHaveBeenCalledTimes(1);
      finishOpen();
      await settle();
      apiFetch.mockResolvedValue(json(200, { url: MINTED }));
      openEcosystemSite('migallery', '/mes-photos');
      await settle();
      expect(apiFetch).toHaveBeenCalledTimes(2);
    });

    it('releases the guard when the mint fails, so a retry is possible', async () => {
      apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      openEcosystemSite('migallery', '/mes-photos');
      await settle();
      apiFetch.mockResolvedValueOnce(json(200, { url: MINTED }));
      openEcosystemSite('migallery', '/mes-photos');
      await settle();
      expect(apiFetch).toHaveBeenCalledTimes(2);
    });

    it('says a failed open by its class, never with the URL that carries the token', async () => {
      apiFetch.mockResolvedValue(json(200, { url: MINTED }));
      openUrl.mockRejectedValueOnce(new Error(`cannot open ${MINTED}`));
      openEcosystemSite('migallery');
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      const said = JSON.stringify(warn.mock.calls);
      expect(said).toContain('class=Error');
      expect(said).not.toContain('eyJ.header.sig');
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

    it.each([
      ['HANDOFF_TERMS_NOT_ACCEPTED', 'terms are not accepted'],
      ['HANDOFF_ALUMNI_LINK_REQUIRED', 'link the Alumni account'],
      ['HANDOFF_ALUMNI_COTISANT_REQUIRED', 'Alumni contributors only'],
    ])(
      'opens through the MiConnect sign-in on %s, said at info and never at warn',
      async (code, words) => {
        apiFetch.mockImplementation(async () => json(403, { code }));
        openEcosystemSite('migallery', '/mes-photos');
        await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));
        // The site's own sign-in, returning to the page the person was going to.
        expect(openUrl).toHaveBeenCalledWith(
          'https://gallery.mitv.fr/api/auth/login?redirectTo=%2Fmes-photos'
        );
        expect(warn).not.toHaveBeenCalled();
        const said = vi.mocked(Log.i).mock.calls.filter(([, line]) => String(line).includes(words));
        expect(said).toHaveLength(1);
      }
    );

    it.each([
      ['HANDOFF_ACCESS_REFUSED', 403],
      ['HANDOFF_MICONNECT_UNAVAILABLE', 503],
      ['HANDOFF_BAD_DEST', 400],
    ])('opens plainly, never through the sign-in, on %s', async (code, status) => {
      apiFetch.mockImplementation(async () => json(status, { code }));
      openEcosystemSite('migallery', '/mes-photos');
      await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1));
      expect(openUrl).toHaveBeenCalledWith('https://gallery.mitv.fr/mes-photos');
      expect(String(warn.mock.calls[0][0])).toContain(`class=${code} (${status})`);
    });

    it('knows every 403 code the contract gives a person MiConnect must see first', () => {
      const contract = JSON.parse(
        readFileSync(resolve('..', 'libs', 'contracts', 'ecosystem-sites.json'), 'utf8')
      ) as { refusals: Record<string, string> };
      expect(
        [
          contract.refusals.termsNotAccepted,
          contract.refusals.alumniLinkRequired,
          contract.refusals.alumniCotisantRequired,
        ].sort()
      ).toEqual(Object.keys(SETTLED_AT_MICONNECT).sort());
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

    it('points the tab at the site sign-in when MiConnect has a page to show first', async () => {
      apiFetch.mockResolvedValue(json(403, { code: 'HANDOFF_TERMS_NOT_ACCEPTED' }));
      const tab = { opener: null, closed: false, location: { href: 'about:blank' } };
      vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
      openEcosystemSite('migallery', '/mes-photos');
      await settle();
      expect(tab.location.href).toBe(
        'https://gallery.mitv.fr/api/auth/login?redirectTo=%2Fmes-photos'
      );
      expect(warn).not.toHaveBeenCalled();
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

  describe('a link written in a message or a post', () => {
    beforeEach(() => {
      (window as TauriWindow).__TAURI_INTERNALS__ = {};
    });

    it('is handed off when it names a flagged site and an allowlisted path', async () => {
      apiFetch.mockResolvedValue(json(200, { url: MINTED }));
      expect(openEcosystemSiteLink('https://gallery.mitv.fr/mes-photos')).toBe(true);
      await settle();
      const [, init] = apiFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ aud: 'migallery', dest: '/mes-photos' });
      expect(openUrl).toHaveBeenCalledWith(MINTED);
    });

    it('names an album by its pattern in every log line, never by its id', async () => {
      apiFetch.mockResolvedValue(json(200, { url: MINTED }));
      const album = '/albums/0b8e6f9a-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
      expect(openEcosystemSiteLink(`https://gallery.mitv.fr${album}`)).toBe(true);
      await settle();
      const [, init] = apiFetch.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ aud: 'migallery', dest: album });
      const said = JSON.stringify([vi.mocked(Log.i).mock.calls, vi.mocked(Log.d).mock.calls]);
      expect(said).toContain('/albums/{uuid}');
      expect(said).not.toContain('0b8e6f9a');
    });

    it.each([
      'https://gallery.mitv.fr/mes-photos/confirmer',
      'https://gallery.mitv.fr/mes-photos?x=1',
      'https://cercle.emse.fr/',
      'https://example.com/mes-photos',
    ])('is left to the ordinary opener, minting nothing: %s', async (href) => {
      expect(openEcosystemSiteLink(href)).toBe(false);
      await settle();
      expect(apiFetch).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
    });

    it('never lets the token leave for another origin than the site the link named', async () => {
      // A minted URL naming another place is refused; the link's own site opens plainly.
      apiFetch.mockResolvedValue(
        json(200, { url: 'https://gallery.mitv.fr.evil.example/auth/handoff#t' })
      );
      openEcosystemSiteLink('https://gallery.mitv.fr/');
      await settle();
      expect(openUrl).toHaveBeenCalledWith('https://gallery.mitv.fr');
      expect(String(warn.mock.calls[0][0])).toContain('class=HandoffUrlMismatchError');
    });
  });

  it('writes a sign-in address that returns only to an allowlisted path', () => {
    const [gallery, cercle] = sites.list as never[];
    expect(signInSiteUrl(gallery, '/mes-photos')).toBe(
      'https://gallery.mitv.fr/api/auth/login?redirectTo=%2Fmes-photos'
    );
    expect(signInSiteUrl(gallery, '/albums/0b8e6f9a-1c2d-4e3f-8a9b-0c1d2e3f4a5b')).toBe(
      'https://gallery.mitv.fr/api/auth/login?redirectTo=%2Falbums%2F0b8e6f9a-1c2d-4e3f-8a9b-0c1d2e3f4a5b'
    );
    // Home needs no return path; a path off the allowlist is never passed.
    expect(signInSiteUrl(gallery, '/')).toBe('https://gallery.mitv.fr/api/auth/login');
    expect(signInSiteUrl(gallery, '/mes-photos/confirmer')).toBe(
      'https://gallery.mitv.fr/api/auth/login'
    );
    expect(signInSiteUrl(gallery, '//evil.example')).toBe('https://gallery.mitv.fr/api/auth/login');
    // A site that reads no return path lands on its home after the sign-in.
    expect(signInSiteUrl(cercle, '/')).toBe('https://cercle.emse.fr/auth/login');
    // A site outside MiConnect has no sign-in to send anyone to.
    const portail = { id: 'portail-etu', href: 'https://p.example', dests: [], signIn: null };
    expect(signInSiteUrl(portail as never, '/')).toBe('https://p.example');
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

  it('finds every origin only in ecosystemSites.ts', () => {
    // The run's source snapshot, no disk walk (the site list itself is outside `src`, read above).
    const files = sourceFiles({ under: 'src', extensions: ['ts', 'svelte'], tests: 'exclude' });
    // The tree the scan thinks it reads: the one allowed file is in it, and so is much more.
    expect(files.map((f) => f.path)).toContain('src/lib/navigation/ecosystemSites.ts');
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const { path: rel, text } of files) {
      if (allowed.has(rel)) continue;
      for (const { origin } of contract.sites) {
        if (text.includes(origin)) offenders.push(`${rel}: ${origin}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
