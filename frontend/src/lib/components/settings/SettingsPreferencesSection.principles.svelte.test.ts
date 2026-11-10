// @vitest-environment happy-dom
/**
 * "NOS PRINCIPES" IN PREFERENCES (owner, 2026-11-10): "Défilement infini des CanaReels" (on by
 * default, kept on this device) and "Lecture automatique des vidéos" (Toujours by default; Wi-Fi
 * says on an engine that reports no link that videos will wait for a tap).
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
    box!.click();
    flushSync();
    expect(settings.infiniteReelsEnabled).toBe(false);
    expect(localStorage.getItem('canari_infinite_reels_enabled')).toBe('false');
  });
});

describe('Lecture automatique des vidéos', () => {
  it('offers Toujours, Wi-Fi, Jamais with Toujours selected, and keeps a pick', async () => {
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

  it('Wi-Fi on an engine that reports no link says videos will wait for a tap', async () => {
    // happy-dom has no `navigator.connection`, as iOS, Safari and Firefox.
    await render();
    expect(document.body.querySelector('[data-video-autoplay-wifi-unknown]')).toBeNull();
    autoplayChoices()[1].click();
    flushSync();
    expect(
      document.body.querySelector('[data-video-autoplay-wifi-unknown]')?.textContent
    ).toContain(m.settings_video_autoplay_wifi_unknown());
  });
});
