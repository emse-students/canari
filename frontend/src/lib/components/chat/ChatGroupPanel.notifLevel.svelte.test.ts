// @vitest-environment happy-dom
/**
 * A PRIVATE CONVERSATION HAS THE SALON'S THREE LEVELS, IN THE SAME CONTROL.
 *
 * The panel shows nothing checked until the server has stated the level, then checks it, and a
 * choice is written for THIS conversation through the store.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))),
}));
const api = vi.hoisted(() => ({
  fetchNotificationPreferences: vi.fn(),
  saveDisabledCategories: vi.fn(),
  saveGroupNotificationLevel: vi.fn(),
}));
vi.mock('$lib/notifications/preferencesApi', () => api);

import ChatGroupPanel from './ChatGroupPanel.svelte';
import { notificationPreferences } from '$lib/stores/notificationPreferences.svelte';
import { m } from '$lib/paraglide/messages';

const G = '0b9f3d7e-1111-4222-8333-444455556666';
const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  notificationPreferences.reset();
  api.saveGroupNotificationLevel.mockResolvedValue(undefined);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

async function render() {
  const c = mount(ChatGroupPanel, {
    target: document.body,
    props: {
      effectiveDisplayName: 'Team',
      contactName: 'team',
      groupId: G,
      isGroupConversation: true,
      currentUserId: 'me',
      groupMembers: ['me', 'peer'],
      onClose: () => {},
    },
  });
  mounted.push(() => void unmount(c));
  await tick();
  await Promise.resolve();
  await tick();
  flushSync();
}

const radio = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) =>
    (b.textContent ?? '').includes(label)
  );

describe('ChatGroupPanel notification level', () => {
  it('checks the level the server stated for this conversation', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: { [G]: 'mentions' },
      groupCalls: {},
    });
    await render();
    expect(radio(m.chat_channel_notif_mentions_label())?.getAttribute('aria-checked')).toBe('true');
    expect(radio(m.chat_channel_notif_all_label())?.getAttribute('aria-checked')).toBe('false');
  });

  it('checks nothing when the levels could not be read', async () => {
    api.fetchNotificationPreferences.mockRejectedValue(new Error('503'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await render();
    const checked = [...document.querySelectorAll('[role="radio"][aria-checked="true"]')];
    expect(checked).toHaveLength(0);
  });

  it('writes a choice for this conversation', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: {},
      groupCalls: {},
    });
    await render();
    radio(m.chat_channel_notif_none_label())!.click();
    await tick();
    flushSync();
    expect(api.saveGroupNotificationLevel).toHaveBeenCalledWith(G, 'none');
    expect(radio(m.chat_channel_notif_none_label())?.getAttribute('aria-checked')).toBe('true');
  });

  it('says so, and puts the level back, when the server refuses the choice', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: {},
      groupCalls: {},
    });
    api.saveGroupNotificationLevel.mockRejectedValueOnce(new Error('403'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    radio(m.chat_channel_notif_mentions_label())!.click();
    for (let i = 0; i < 3; i++) await tick();
    flushSync();
    expect(radio(m.chat_channel_notif_all_label())?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      m.chat_notif_level_save_error()
    );
    expect(warn).toHaveBeenCalled();
  });

  it('re-reads the levels at every opening, so a change made on another device shows', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: {},
      groupCalls: {},
    });
    await notificationPreferences.load();
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: { [G]: 'none' },
      groupCalls: {},
    });
    await render();
    expect(radio(m.chat_channel_notif_none_label())?.getAttribute('aria-checked')).toBe('true');
  });
});
