import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const api = vi.hoisted(() => ({
  fetchDisabledCategories: vi.fn(),
  saveDisabledCategories: vi.fn(),
}));
vi.mock('$lib/notifications/preferencesApi', () => api);

import SettingsNotificationsSection from './SettingsNotificationsSection.svelte';
import { notificationPreferences } from '$lib/stores/notificationPreferences.svelte';
import { NOTIFICATION_CATEGORIES } from '$lib/notifications/categories';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;

async function settle() {
  for (let i = 0; i < 5; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

const switchOf = (category: string) =>
  document.querySelector<HTMLButtonElement>(`[data-category="${category}"] button[role="switch"]`)!;

beforeEach(() => {
  vi.clearAllMocks();
  notificationPreferences.reset();
  api.fetchDisabledCategories.mockResolvedValue([]);
  api.saveDisabledCategories.mockResolvedValue(undefined);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

async function render() {
  component = mount(SettingsNotificationsSection, { target: document.body });
  await settle();
}

describe('SettingsNotificationsSection', () => {
  it('draws one switch per category, all on by default', async () => {
    await render();
    expect(document.querySelectorAll('button[role="switch"]')).toHaveLength(
      NOTIFICATION_CATEGORIES.length
    );
    for (const c of NOTIFICATION_CATEGORIES) {
      expect(switchOf(c).getAttribute('aria-checked')).toBe('true');
    }
  });

  it('shows the account state the server returned', async () => {
    api.fetchDisabledCategories.mockResolvedValue(['posts']);
    await render();
    expect(switchOf('posts').getAttribute('aria-checked')).toBe('false');
    expect(switchOf('messages').getAttribute('aria-checked')).toBe('true');
  });

  it('writes the choice to the server when a switch is flipped', async () => {
    await render();
    switchOf('reactions').click();
    await settle();
    expect(api.saveDisabledCategories).toHaveBeenCalledWith(['reactions']);
    expect(switchOf('reactions').getAttribute('aria-checked')).toBe('false');
  });

  it('puts the switch back and says so when the write fails', async () => {
    api.saveDisabledCategories.mockRejectedValueOnce(new Error('500'));
    await render();
    switchOf('forms').click();
    await settle();
    expect(switchOf('forms').getAttribute('aria-checked')).toBe('true');
    expect(document.body.textContent).toContain(m.settings_notifications_save_error());
  });

  it('says so when the choices cannot be loaded', async () => {
    api.fetchDisabledCategories.mockRejectedValue(new Error('503'));
    await render();
    expect(document.body.textContent).toContain(m.settings_notifications_load_error());
  });
});
