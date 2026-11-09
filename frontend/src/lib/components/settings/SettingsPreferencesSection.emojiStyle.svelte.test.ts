// @vitest-environment happy-dom
/**
 * THE "EMOJIS" SETTING (owner, 2026-11-09): two choices in Preferences, "Systeme" selected when
 * nothing was ever chosen, and a pick both stored on this device and applied at once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/posts/api', () => ({
  getRepostSettings: vi.fn().mockResolvedValue({ allowReposts: true }),
  setRepostSettings: vi.fn(),
}));

import SettingsPreferencesSection from './SettingsPreferencesSection.svelte';
import { m } from '$lib/paraglide/messages';
import { currentEmojiStyle, setEmojiStyle } from '$lib/utils/emojiStyle';

let component: ReturnType<typeof mount> | null = null;

async function render() {
  component = mount(SettingsPreferencesSection, { target: document.body });
  await tick();
  flushSync();
}

function emojiChoices(): HTMLButtonElement[] {
  const group = document.body.querySelector(
    `[role="tablist"][aria-label="${m.settings_emoji_style_label()}"]`
  );
  expect(group).not.toBeNull();
  return [...group!.querySelectorAll<HTMLButtonElement>('button')];
}

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
  setEmojiStyle('system');
  localStorage.removeItem('canari_emoji_style');
});

describe('the Emojis setting', () => {
  it('offers System then Canari, with System selected by default', async () => {
    await render();
    const [system, canari] = emojiChoices();
    expect(system.textContent?.trim()).toBe(m.settings_emoji_style_system());
    expect(canari.textContent?.trim()).toBe(m.settings_emoji_style_canari());
    expect(system.getAttribute('aria-selected')).toBe('true');
    expect(canari.getAttribute('aria-selected')).toBe('false');
    expect(document.body.textContent).toContain(m.settings_emoji_style_desc());
  });

  it('stores and applies a pick, and back', async () => {
    await render();
    emojiChoices()[1].click();
    flushSync();
    expect(currentEmojiStyle()).toBe('canari');
    expect(localStorage.getItem('canari_emoji_style')).toBe('canari');
    expect(emojiChoices()[1].getAttribute('aria-selected')).toBe('true');

    emojiChoices()[0].click();
    flushSync();
    expect(currentEmojiStyle()).toBe('system');
    expect(localStorage.getItem('canari_emoji_style')).toBe('system');
  });
});
