// @vitest-environment happy-dom
/**
 * "NOS PRINCIPES" IN PREFERENCES (owner, 2026-11-10): "Défilement infini des CanaReels" (on by
 * default, kept on this device) and "Lecture automatique des vidéos" (Toujours by default; no Wi-Fi
 * choice where the engine reports no link, owner 2026-11-11).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/posts/api', () => ({
  getRepostSettings: vi.fn().mockResolvedValue({ allowReposts: true }),
  setRepostSettings: vi.fn(),
  getActivitySettings: vi.fn().mockResolvedValue({ shareActivity: false }),
  setActivitySettings: vi.fn(),
}));

import SettingsPreferencesSection from './SettingsPreferencesSection.svelte';
import { m } from '$lib/paraglide/messages';
import { settings } from '$lib/stores/settingsStore.svelte';

let component: ReturnType<typeof mount> | null = null;

async function render() {
  component = mount(SettingsPreferencesSection, { target: document.body });
  await tick();
  flushSync();
}

function autoplayChoices(): HTMLButtonElement[] {
  const group = document.body.querySelector(
    `[role="tablist"][aria-label="${m.settings_video_autoplay_label()}"]`
  );
  expect(group).not.toBeNull();
  return [...group!.querySelectorAll<HTMLButtonElement>('button')];
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
  settings.setInfiniteReelsEnabled(true);
  settings.setVideoAutoplay('');
});

describe('Défilement infini des CanaReels', () => {
  it('is on by default, and turning it off is kept on this device', async () => {
    await render();
    const box = document.body.querySelector<HTMLInputElement>(
      '[data-infinite-reels-setting] input[type="checkbox"]'
    );
    expect(box?.checked).toBe(true);
    // Same row as its neighbours: an icon tile on the left, the switch on the right.
    const row = document.body.querySelector('[data-infinite-reels-setting] label')!;
    expect(row.firstElementChild?.querySelector('svg')).not.toBeNull();
    expect(row.lastElementChild).toBe(box!.parentElement);
    box!.click();
    flushSync();
    expect(settings.infiniteReelsEnabled).toBe(false);
    expect(localStorage.getItem('canari_infinite_reels_enabled')).toBe('false');
  });
});

describe('Lecture automatique des vidéos', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A device whose engine reports its link, as Chromium (the Android app) does. */
  function reportsLink(type: string) {
    const connection = Object.assign(new EventTarget(), { type });
    vi.stubGlobal('navigator', { ...navigator, connection });
  }

  it('offers Toujours, Wi-Fi, Jamais where the device tells its link, Toujours selected, and keeps a pick', async () => {
    reportsLink('wifi');
    await render();
    const [always, wifi, never] = autoplayChoices();
    expect(always.textContent?.trim()).toBe(m.settings_video_autoplay_always());
    expect(wifi.textContent?.trim()).toBe(m.settings_video_autoplay_wifi());
    expect(never.textContent?.trim()).toBe(m.settings_video_autoplay_never());
    expect(always.getAttribute('aria-selected')).toBe('true');
    never.click();
    flushSync();
    expect(settings.videoAutoplay).toBe('never');
    expect(localStorage.getItem('canari_video_autoplay')).toBe('never');
  });

  it('offers no Wi-Fi where the device cannot tell its link (owner, 2026-11-11)', async () => {
    // happy-dom has no `navigator.connection`, as iOS, Safari and Firefox.
    await render();
    expect(autoplayChoices().map((b) => b.textContent?.trim())).toEqual([
      m.settings_video_autoplay_always(),
      m.settings_video_autoplay_never(),
    ]);
  });

  it('a stored Wi-Fi on such a device is drawn as Jamais, which is what it does', async () => {
    settings.setVideoAutoplay('wifi');
    await render();
    const [, never] = autoplayChoices();
    expect(never.getAttribute('aria-selected')).toBe('true');
  });
});
