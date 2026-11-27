// @vitest-environment happy-dom
const openUrl = vi.fn();
const confirmUnsafeLinkIfNeeded = vi.fn();

vi.mock('$lib/utils/appLinkNavigation', () => ({
  navigateInAppFromHref: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/utils/checkLinkSafety', () => ({
  confirmUnsafeLinkIfNeeded: (...args: unknown[]) => confirmUnsafeLinkIfNeeded(...args),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (...args: unknown[]) => openUrl(...args) }));
/** The handoff of a sibling-site link: its matching is pinned in `ecosystemSites.test.ts`. */
const openEcosystemSiteLink = vi.fn((_url: string) => false);
vi.mock('$lib/navigation/openEcosystemSite', () => ({
  openEcosystemSiteLink: (url: string) => openEcosystemSiteLink(url),
}));

import {
  ECOSYSTEM_SITE_ATTRIBUTE,
  OWNS_CLICK_ATTRIBUTE,
  handleAppLinkClick,
  installAppLinkClickHandler,
  openExternal,
} from './openExternal';
import { navigateInAppFromHref } from '$lib/utils/appLinkNavigation';
import { flushMacrotask } from '../../test/flush';

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

/** Makes `isTauriRuntime()` answer `true` for the duration of a test. */
function pretendTauri() {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
}

describe('handleAppLinkClick', () => {
  it('leaves an ecosystem-site anchor to its own onclick, even on Tauri', () => {
    pretendTauri();
    try {
      document.body.innerHTML = `<a id="site" href="https://gallery.mitv.fr" ${ECOSYSTEM_SITE_ATTRIBUTE}="migallery">MiGallery</a>`;
      const anchor = document.getElementById('site') as HTMLAnchorElement;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: anchor });
      expect(handleAppLinkClick(event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
      expect(openUrl).not.toHaveBeenCalled();
    } finally {
      delete (window as TauriWindow).__TAURI_INTERNALS__;
    }
  });

  it('leaves an anchor that owns its click to its own onclick, through the document listener', () => {
    document.body.innerHTML = `<a id="reel" href="/posts/p1" ${OWNS_CLICK_ATTRIBUTE}>Reel</a>`;
    const anchor = document.getElementById('reel') as HTMLAnchorElement;
    const own = vi.fn((e: Event) => e.preventDefault());
    anchor.addEventListener('click', own);
    installAppLinkClickHandler();
    try {
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(own).toHaveBeenCalledTimes(1);
      expect(navigateInAppFromHref).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('click', handleAppLinkClick, true);
    }
  });

  it('navigates in-app for supported relative paths', () => {
    document.body.innerHTML = '<a id="link" href="/calendar">Agenda</a>';
    const anchor = document.getElementById('link') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    vi.spyOn(event, 'preventDefault');
    vi.spyOn(event, 'stopPropagation');

    Object.defineProperty(event, 'target', { value: anchor });
    expect(handleAppLinkClick(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(navigateInAppFromHref).toHaveBeenCalledWith('/calendar');
  });

  it('does not swallow public Canari URLs without an in-app mapping', () => {
    document.body.innerHTML = '<a id="ext" href="https://canari.emse.fr/api/version">API</a>';
    const anchor = document.getElementById('ext') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    vi.spyOn(event, 'preventDefault');

    Object.defineProperty(event, 'target', { value: anchor });
    expect(handleAppLinkClick(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('navigates in-app for public Canari URLs outside the rich-label allowlist', () => {
    document.body.innerHTML =
      '<a id="settings" href="https://canari.emse.fr/settings" target="_blank">Reglages</a>';
    const anchor = document.getElementById('settings') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    vi.spyOn(event, 'preventDefault');

    Object.defineProperty(event, 'target', { value: anchor });
    expect(handleAppLinkClick(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(navigateInAppFromHref).toHaveBeenCalledWith('https://canari.emse.fr/settings');
  });

  it('navigates in-app for admin dashboard links', () => {
    document.body.innerHTML = '<a id="admin" href="/admin/platform">Plateforme</a>';
    const anchor = document.getElementById('admin') as HTMLAnchorElement;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });

    Object.defineProperty(event, 'target', { value: anchor });
    expect(handleAppLinkClick(event)).toBe(true);
    expect(navigateInAppFromHref).toHaveBeenCalledWith('/admin/platform');
  });

  describe('external links on Tauri', () => {
    beforeEach(() => {
      pretendTauri();
      openUrl.mockReset();
      confirmUnsafeLinkIfNeeded.mockReset();
    });

    afterEach(() => {
      delete (window as TauriWindow).__TAURI_INTERNALS__;
    });

    it('routes an external link through openExternal, which asks Safe Browsing before opening', async () => {
      confirmUnsafeLinkIfNeeded.mockResolvedValue(true);
      document.body.innerHTML = '<a id="ext" href="https://example.com/promo">Promo</a>';
      const anchor = document.getElementById('ext') as HTMLAnchorElement;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: anchor });

      expect(handleAppLinkClick(event)).toBe(true);
      // handleAppLinkClick fires openExternal without awaiting it (`void openExternal(href)`).
      await flushMacrotask();

      expect(confirmUnsafeLinkIfNeeded).toHaveBeenCalledWith('https://example.com/promo');
      expect(openUrl).toHaveBeenCalledWith('https://example.com/promo');
    });

    it('never reaches the OS browser when Safe Browsing (or the user) refuses the link - this is the regression that shipped without a test', async () => {
      confirmUnsafeLinkIfNeeded.mockResolvedValue(false);
      document.body.innerHTML = '<a id="ext" href="https://evil.example.com">Evil</a>';
      const anchor = document.getElementById('ext') as HTMLAnchorElement;
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: anchor });

      expect(handleAppLinkClick(event)).toBe(true);
      await flushMacrotask();

      expect(confirmUnsafeLinkIfNeeded).toHaveBeenCalledWith('https://evil.example.com/');
      expect(openUrl).not.toHaveBeenCalled();
    });
  });
});

describe('openExternal', () => {
  beforeEach(() => {
    openUrl.mockReset();
    confirmUnsafeLinkIfNeeded.mockReset();
    openEcosystemSiteLink.mockReset();
    openEcosystemSiteLink.mockReturnValue(false);
    delete (window as TauriWindow).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a new tab on the web once the Safe Browsing gate passes', async () => {
    confirmUnsafeLinkIfNeeded.mockResolvedValue(true);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    await openExternal('https://example.com/article');

    expect(open).toHaveBeenCalledWith(
      'https://example.com/article',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('opens via the system browser plugin on Tauri once the Safe Browsing gate passes', async () => {
    pretendTauri();
    confirmUnsafeLinkIfNeeded.mockResolvedValue(true);

    await openExternal('https://example.com/article');

    expect(openUrl).toHaveBeenCalledWith('https://example.com/article');
  });

  it('opens nothing, on web or Tauri, when the gate refuses', async () => {
    confirmUnsafeLinkIfNeeded.mockResolvedValue(false);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    await openExternal('https://evil.example.com');

    expect(open).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('hands a sibling-site link to the handoff once the gate passes, and opens nothing else', async () => {
    const order: string[] = [];
    confirmUnsafeLinkIfNeeded.mockImplementation(async () => {
      order.push('gate');
      return true;
    });
    openEcosystemSiteLink.mockImplementation(() => {
      order.push('handoff');
      return true;
    });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    await openExternal('https://site.example/mes-photos');

    expect(order).toEqual(['gate', 'handoff']);
    expect(openEcosystemSiteLink).toHaveBeenCalledWith('https://site.example/mes-photos');
    expect(open).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('never hands a link the gate refused to the handoff - Safe Browsing runs first for every link', async () => {
    confirmUnsafeLinkIfNeeded.mockResolvedValue(false);
    openEcosystemSiteLink.mockReturnValue(true);

    await openExternal('https://site.example/mes-photos');

    expect(openEcosystemSiteLink).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('never hands a link to the sibling-site handoff when the caller refuses it (a mail link)', async () => {
    confirmUnsafeLinkIfNeeded.mockResolvedValue(true);
    openEcosystemSiteLink.mockReturnValue(true);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    await openExternal('https://site.example/mes-photos', { siteHandoff: false });

    expect(confirmUnsafeLinkIfNeeded).toHaveBeenCalledWith('https://site.example/mes-photos');
    expect(openEcosystemSiteLink).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(
      'https://site.example/mes-photos',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('opens a link the handoff declines exactly as before', async () => {
    confirmUnsafeLinkIfNeeded.mockResolvedValue(true);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);

    await openExternal('https://site.example/admin');

    expect(openEcosystemSiteLink).toHaveBeenCalledWith('https://site.example/admin');
    expect(open).toHaveBeenCalledWith(
      'https://site.example/admin',
      '_blank',
      'noopener,noreferrer'
    );
  });
});
