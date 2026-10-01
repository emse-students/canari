/**
 * THE iOS APP'S BOTTOM BAR IS A NATIVE UITabBar (user, 2026-09-29) - Liquid Glass on iOS 26.
 *
 * Nothing here runs the native half: the plugin is mocked, and what these pin is what Canari
 * ASKS of it - the same four places as the web bar, icons only, the same dot, the same visibility
 * rule, the measured reserve, and the web bar handed back when the native one cannot be set up.
 * Whether it LOOKS right is owed on an iPhone.
 */
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const plugin = vi.hoisted(() => ({
  configureTabBar: vi.fn(),
  onTabSelected: vi.fn(),
  getTabBarInsets: vi.fn(),
  showTabBar: vi.fn(),
  hideTabBar: vi.fn(),
  selectTab: vi.fn(),
  setBadge: vi.fn(),
  removeTabBar: vi.fn(),
}));
vi.mock('@sosweetham/tauri-plugin-system-components-api', () => plugin);

const route = vi.hoisted(() => ({ page: { url: new URL('https://canari.emse.fr/posts') } }));
vi.mock('$app/state', () => route);

const nav = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => nav);

const badges = vi.hoisted(() => ({ placeBadge: vi.fn() }));
vi.mock('$lib/navigation/placeBadge.svelte', () => badges);

// happy-dom has no real canvas: a glyph is named by the component it was drawn from and its colour,
// and a colour by its class and the theme.
const icons = vi.hoisted(() => ({
  lucideIconPng: vi.fn(),
  classColorHex: vi.fn(),
  TAB_ICON_CLASSES: { normal: 'text-class', selected: 'accent-class' },
}));
vi.mock('$lib/mobile/nativeTabIcons', () => icons);

import NativeTabBar, { nativeTabBar } from './NativeTabBar.svelte';
import { MOBILE_NAV_PLACES } from '$lib/navigation/places';
import { PLACE_ICONS } from '$lib/navigation/placeIcons';
import { themeStore } from '$lib/stores/themeStore.svelte';

const mounted: (() => void)[] = [];
let selectTabHandler: ((e: { id: string }) => void) | null = null;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  for (const fn of Object.values(plugin)) fn.mockReset();
  plugin.configureTabBar.mockResolvedValue(undefined);
  plugin.onTabSelected.mockImplementation(async (h: (e: { id: string }) => void) => {
    selectTabHandler = h;
    return { unregister: vi.fn().mockResolvedValue(undefined) };
  });
  plugin.getTabBarInsets.mockResolvedValue({ bottom: 83 });
  for (const f of [
    plugin.showTabBar,
    plugin.hideTabBar,
    plugin.selectTab,
    plugin.setBadge,
    plugin.removeTabBar,
  ]) {
    f.mockResolvedValue(undefined);
  }
  nav.goto.mockReset();
  icons.lucideIconPng.mockReset().mockImplementation(async (icon: unknown, color: string) => {
    const name = Object.entries(PLACE_ICONS).find(([, c]) => c === icon)?.[0];
    return `png:${name}:${color}`;
  });
  icons.classColorHex
    .mockReset()
    .mockImplementation((cls: string) => `${cls}@${themeStore.isDark ? 'dark' : 'light'}`);
  themeStore.setPreference('light');
  badges.placeBadge.mockReset().mockReturnValue(0);
  nativeTabBar.status = 'pending';
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.documentElement.style.removeProperty('--bottom-nav-reserve');
  window.matchMedia = originalMatchMedia;
});
afterAll(() => {
  vi.restoreAllMocks();
  themeStore.setPreference('system');
});

/** Mounts the bar and lets its asynchronous setup and effects settle. */
async function mountBar(props: { visible: boolean }) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const state = $state(props);
  const app = mount(NativeTabBar, { target, props: state });
  mounted.push(() => void unmount(app));
  for (let i = 0; i < 6; i++) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
  return state;
}

describe('NativeTabBar', () => {
  it("offers the web bar's glyphs in the text colour, the selected state in yellow, and no tint", async () => {
    await mountBar({ visible: true });

    const [options] = plugin.configureTabBar.mock.calls[0];
    const { items, selectedId } = options;
    expect(items.map((i: { id: string }) => i.id)).toEqual(MOBILE_NAV_PLACES.map((p) => p.id));
    // Icons only - the user's decision, VoiceOver included (see the component).
    expect(items.every((i: { title: string }) => i.title === '')).toBe(true);
    // The SAME Lucide glyph the web bar draws, once per state, each already in its colour.
    for (const [i, place] of MOBILE_NAV_PLACES.entries()) {
      expect(items[i].image).toBe(`png:${place.icon}:text-class@light`);
      expect(items[i].selectedImage).toBe(`png:${place.icon}:accent-class@light`);
      expect(items[i].sfSymbol).toBeUndefined();
    }
    // The bar itself is not tinted (user, 2026-09-30): both states are drawn, nothing is tinted.
    expect(options).not.toHaveProperty('tint');
    expect(selectedId).toBe('posts');
    expect(nativeTabBar.status).toBe('native');
  });

  it('redraws for the dark theme, and sends the badges again - a reconfiguration clears them', async () => {
    badges.placeBadge.mockImplementation((id: string) => (id === 'chat' ? 1 : 0));
    await mountBar({ visible: true });
    plugin.setBadge.mockClear();

    themeStore.setPreference('dark');
    for (let i = 0; i < 6; i++) {
      await tick();
      await Promise.resolve();
    }

    expect(plugin.configureTabBar).toHaveBeenCalledTimes(2);
    const [{ items }] = plugin.configureTabBar.mock.calls[1];
    expect(items[0].image).toBe(`png:${MOBILE_NAV_PLACES[0].icon}:text-class@dark`);
    expect(items[0].selectedImage).toBe(`png:${MOBILE_NAV_PLACES[0].icon}:accent-class@dark`);
    expect(plugin.setBadge).toHaveBeenCalledWith('chat', '');
  });

  it('redraws for light after a dark start the store learnt only after the first draw', async () => {
    // The phone: app.html sets data-theme="dark" before paint, this bar's onMount runs before the
    // layout's themeStore.init(), so the first glyphs are drawn dark while the store still says light.
    icons.classColorHex.mockImplementation(
      (cls: string) => `${cls}@${document.documentElement.dataset.theme}`
    );
    document.documentElement.dataset.theme = 'dark';
    let initialised = false;
    icons.lucideIconPng.mockImplementation(async (icon: unknown, color: string) => {
      if (!initialised) {
        initialised = true;
        themeStore.setPreference('dark'); // the layout's init, landing mid-setup
      }
      const name = Object.entries(PLACE_ICONS).find(([, c]) => c === icon)?.[0];
      return `png:${name}:${color}`;
    });
    await mountBar({ visible: true });
    expect(plugin.configureTabBar.mock.calls[0][0].items[0].image).toBe(
      `png:${MOBILE_NAV_PLACES[0].icon}:text-class@dark`
    );

    themeStore.setPreference('light');
    for (let i = 0; i < 6; i++) {
      await tick();
      await Promise.resolve();
    }
    const last = plugin.configureTabBar.mock.calls.at(-1)![0];
    expect(last.items[0].image).toBe(`png:${MOBILE_NAV_PLACES[0].icon}:text-class@light`);
  });

  it('navigates to the place a tab names', async () => {
    await mountBar({ visible: true });
    selectTabHandler!({ id: 'chat' });
    expect(nav.goto).toHaveBeenCalledWith('/chat');
  });

  it('reserves the space the plugin measures, not the web bar’s 4rem', async () => {
    await mountBar({ visible: true });
    expect(document.documentElement.style.getPropertyValue('--bottom-nav-reserve')).toBe('83px');
  });

  it('hides with the layout rule, and shows again', async () => {
    const state = await mountBar({ visible: false });
    expect(plugin.hideTabBar).toHaveBeenCalled();

    state.visible = true;
    for (let i = 0; i < 4; i++) await tick();
    expect(plugin.showTabBar).toHaveBeenCalled();
  });

  it('draws the unread dot as an empty badge, and sends nothing that did not change', async () => {
    badges.placeBadge.mockImplementation((id: string) => (id === 'chat' ? 3 : 0));
    await mountBar({ visible: true });

    expect(plugin.setBadge).toHaveBeenCalledWith('chat', '');
    expect(plugin.setBadge).toHaveBeenCalledWith('posts', undefined);
    expect(plugin.setBadge).toHaveBeenCalledTimes(MOBILE_NAV_PLACES.length);
  });

  it('hands the bottom back to the web bar, loudly, when the native bar cannot be configured', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    plugin.configureTabBar.mockRejectedValue(new Error('host view controller unavailable'));

    await mountBar({ visible: true });

    expect(nativeTabBar.status).toBe('failed');
    expect(error.mock.calls.flat().join(' ')).toContain('web bar');
    error.mockRestore();
  });
});
