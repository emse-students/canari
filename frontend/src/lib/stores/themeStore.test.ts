import { themeStore } from './themeStore.svelte';

/** OS dark-mode flag piloté par le test, lu par le stub matchMedia. */
let osDark = false;

beforeEach(() => {
  osDark = false;
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  (window as any).matchMedia = vi.fn((query: string) => ({
    matches: query.includes('dark') ? osDark : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

describe('themeStore', () => {
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

  it('toggle() pose une préférence explicite opposée (sort du mode système)', () => {
    themeStore.setPreference('light');
    themeStore.toggle();
    expect(themeStore.preference).toBe('dark');
    expect(themeStore.isDark).toBe(true);
    themeStore.toggle();
    expect(themeStore.preference).toBe('light');
    expect(themeStore.isDark).toBe(false);
  });

  it("init() sans préférence sauvée → défaut 'system'", () => {
    osDark = true;
    themeStore.init();
    expect(themeStore.preference).toBe('system');
    expect(themeStore.isDark).toBe(true);
  });
});
