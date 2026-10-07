import { describe, it, expect, beforeEach, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchDisabledCategories: vi.fn(),
  saveDisabledCategories: vi.fn(),
}));
vi.mock('$lib/notifications/preferencesApi', () => api);

import { notificationPreferences } from './notificationPreferences.svelte';

beforeEach(() => {
  vi.clearAllMocks();
  notificationPreferences.reset();
  api.saveDisabledCategories.mockResolvedValue(undefined);
});

describe('notificationPreferences', () => {
  it('has everything on until the server says otherwise', () => {
    expect(notificationPreferences.isEnabled('messages')).toBe(true);
    expect(notificationPreferences.disabled).toEqual([]);
  });

  it('mirrors the server set after a load', async () => {
    api.fetchDisabledCategories.mockResolvedValue(['posts', 'forms']);
    expect(await notificationPreferences.load()).toBe(true);
    expect(notificationPreferences.isEnabled('posts')).toBe(false);
    expect(notificationPreferences.isEnabled('messages')).toBe(true);
  });

  it('keeps the current set and reports false when the load fails', async () => {
    api.fetchDisabledCategories.mockResolvedValueOnce(['posts']);
    await notificationPreferences.load();
    api.fetchDisabledCategories.mockRejectedValueOnce(new Error('503'));
    expect(await notificationPreferences.load()).toBe(false);
    expect(notificationPreferences.isEnabled('posts')).toBe(false);
  });

  it('moves the switch at once and sends the whole disabled set', async () => {
    const pending = notificationPreferences.setEnabled('events', false);
    expect(notificationPreferences.isEnabled('events')).toBe(false);
    expect(await pending).toBe(true);
    expect(api.saveDisabledCategories).toHaveBeenCalledWith(['events']);

    await notificationPreferences.setEnabled('forms', false);
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith(['events', 'forms']);

    await notificationPreferences.setEnabled('events', true);
    expect(api.saveDisabledCategories).toHaveBeenLastCalledWith(['forms']);
  });

  it('puts the switch back when the server refuses the write', async () => {
    api.saveDisabledCategories.mockRejectedValueOnce(new Error('500'));
    expect(await notificationPreferences.setEnabled('mentions', false)).toBe(false);
    expect(notificationPreferences.isEnabled('mentions')).toBe(true);
  });

  it('writes nothing when the switch is already where it was asked to go', async () => {
    expect(await notificationPreferences.setEnabled('messages', true)).toBe(true);
    expect(api.saveDisabledCategories).not.toHaveBeenCalled();
  });

  it('forgets the set on reset, so the next account never inherits it', async () => {
    await notificationPreferences.setEnabled('posts', false);
    notificationPreferences.reset();
    expect(notificationPreferences.isEnabled('posts')).toBe(true);
  });
});
