// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const api = vi.hoisted(() => ({
  fetchNotificationPreferences: vi.fn(),
  saveDisabledCategories: vi.fn(),
}));
vi.mock('$lib/notifications/preferencesApi', () => api);
const suggestions = vi.hoisted(() => ({ resetSuggestions: vi.fn() }));
vi.mock('$lib/follows/suggestions.svelte', () => suggestions);
// The reduced-bells list is its own component with its own test; here it only has to be quiet.
vi.mock('$lib/follows/bell', () => ({
  listReducedBells: vi.fn(() => Promise.resolve([])),
  setBellLevel: vi.fn(),
}));

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
  api.fetchNotificationPreferences.mockResolvedValue({
    disabled: [],
    unknownDisabled: [],
    pushEnabled: [],
    groupLevels: {},
    groupCalls: {},
  });
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
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: ['posts'],
      unknownDisabled: [],
      pushEnabled: [],
      groupLevels: {},
      groupCalls: {},
    });
    await render();
    expect(switchOf('posts').getAttribute('aria-checked')).toBe('false');
    expect(switchOf('messages').getAttribute('aria-checked')).toBe('true');
  });

  it('writes the choice to the server when a switch is flipped', async () => {
    await render();
    switchOf('reactions').click();
    await settle();
    expect(api.saveDisabledCategories).toHaveBeenCalledWith(['reactions'], [], []);
    expect(switchOf('reactions').getAttribute('aria-checked')).toBe('false');
  });

  it('a Suggestions change forgets the follow suggestions read for the old choice; another does not', async () => {
    await render();
    switchOf('reactions').click();
    await settle();
    expect(suggestions.resetSuggestions).not.toHaveBeenCalled();
    switchOf('suggestions').click();
    await settle();
    expect(suggestions.resetSuggestions).toHaveBeenCalledTimes(1);
  });

  it('draws the push of Suggestions apart, off by default; turning it on writes the push and keeps the app switch on', async () => {
    await render();
    const push = document.querySelector<HTMLInputElement>(
      '[data-category-push="suggestions"] input[type="checkbox"]'
    )!;
    expect(push.checked).toBe(false);
    // Switch on the right, like its neighbours (no icon tile in Notifications).
    expect(push.closest('label')?.lastElementChild).toBe(push.parentElement);
    expect(switchOf('suggestions').getAttribute('aria-checked')).toBe('true');
    push.click();
    await settle();
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith([], [], ['suggestions']);
    expect(switchOf('suggestions').getAttribute('aria-checked')).toBe('true');
    // One gesture switches both off.
    switchOf('suggestions').click();
    await settle();
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith(['suggestions'], [], []);
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-category-push="suggestions"] input[type="checkbox"]'
      )!.checked
    ).toBe(false);
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
    api.fetchNotificationPreferences.mockRejectedValue(new Error('503'));
    await render();
    expect(document.body.textContent).toContain(m.settings_notifications_load_error());
  });
});
