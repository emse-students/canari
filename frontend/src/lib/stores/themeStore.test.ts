import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { themeStore } from './themeStore.svelte';

/** OS dark-mode flag driven by the test, read by the matchMedia stub. */
let osDark = false;
/** Listeners the store registered on the media query, so a test can fire an OS switch. */
let osListeners: Array<(e: { matches: boolean }) => void> = [];

beforeEach(() => {
  osDark = false;
  osListeners = [];
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  (window as any).matchMedia = vi.fn((query: string) => ({
    matches: query.includes('dark') ? osDark : false,
    media: query,
    addEventListener: vi.fn((_t: string, cb: (e: { matches: boolean }) => void) => {
      osListeners.push(cb);
    }),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

describe('themeStore', () => {
  it("en mode 'system', un changement d'OS pendant que l'app est ouverte est suivi en direct", () => {
    osDark = false;
    themeStore.setPreference('system');
    expect(document.documentElement.dataset.theme).toBe('light');
    for (const cb of osListeners) cb({ matches: true });
    expect(themeStore.isDark).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it("une préférence explicite ignore un changement d'OS", () => {
    themeStore.setPreference('light');
    for (const cb of osListeners) cb({ matches: true });
    expect(themeStore.isDark).toBe(false);
  });

  it('le script avant-premier-paint de app.html décide comme le store', () => {
    const html = readFileSync(resolve(process.cwd(), 'src/app.html'), 'utf8');
    const script =
      /<script>\s*\(function \(\) \{\s*try \{\s*var saved = localStorage[\s\S]*?<\/script>/.exec(
        html
      );
    expect(script).not.toBeNull();
    const body = script![0].replace(/^<script>/, '').replace(/<\/script>$/, '');
    for (const saved of [null, 'system', 'light', 'dark'] as const) {
      for (const os of [false, true]) {
        osDark = os;
        localStorage.clear();
        if (saved) localStorage.setItem('canari-theme', saved);
        document.documentElement.dataset.theme = 'light';
        new Function(body)();
        const early = document.documentElement.dataset.theme;
        themeStore.init();
        expect(early, `saved=${saved} os=${os}`).toBe(themeStore.isDark ? 'dark' : 'light');
      }
    }
  });

  it("setPreference('dark') active le mode sombre, persiste et applique data-theme", () => {
    themeStore.setPreference('dark');
    expect(themeStore.isDark).toBe(true);
    expect(themeStore.preference).toBe('dark');
    expect(localStorage.getItem('canari-theme')).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it("setPreference('light') désactive le mode sombre", () => {
    themeStore.setPreference('light');
    expect(themeStore.isDark).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it("en mode 'system', isDark suit la préférence OS", () => {
    osDark = true;
    themeStore.setPreference('system');
    expect(themeStore.preference).toBe('system');
    expect(themeStore.isDark).toBe(true);

    osDark = false;
    themeStore.setPreference('system');
    expect(themeStore.isDark).toBe(false);
  });

  it('cycle() parcourt automatique -> clair -> sombre -> automatique', () => {
    themeStore.setPreference('system');
    const seen = [themeStore.preference];
    for (let n = 0; n < 3; n++) {
      themeStore.cycle();
      seen.push(themeStore.preference);
    }
    expect(seen).toEqual(['system', 'light', 'dark', 'system']);
  });

  it("init() sans préférence sauvée → défaut 'system'", () => {
    osDark = true;
    themeStore.init();
    expect(themeStore.preference).toBe('system');
    expect(themeStore.isDark).toBe(true);
  });

  it('prévient le shell natif iOS du thème, quand il écoute', () => {
    const postMessage = vi.fn();
    (window as any).webkit = { messageHandlers: { canariTheme: { postMessage } } };
    themeStore.setPreference('dark');
    themeStore.setPreference('light');
    expect(postMessage.mock.calls).toEqual([['dark'], ['light']]);
    delete (window as any).webkit;
  });

  it('ne fait rien sans shell natif (Android, navigateur)', () => {
    delete (window as any).webkit;
    expect(() => themeStore.setPreference('dark')).not.toThrow();
  });
});
