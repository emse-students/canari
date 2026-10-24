// @vitest-environment happy-dom
/**
 * A DIRECT CONVERSATION HAS ITS OWN CALL PERMISSION, BESIDE THE LEVEL.
 *
 * Offered only where a call can be placed (a DM of a build with calls on); checked from the store's
 * answer - the level's default until the account chooses - and written for THIS conversation.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

vi.mock('$lib/features', async (orig) => ({
  ...(await orig<typeof import('$lib/features')>()),
  CALLS_ENABLED: true,
}));
vi.mock('$lib/stores/appVersionCheck.svelte', async (orig) => ({
  ...(await orig<typeof import('$lib/stores/appVersionCheck.svelte')>()),
  serverCallsMode: () => 'audio',
}));
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
  saveGroupCallsAllowed: vi.fn(),
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
  api.saveGroupCallsAllowed.mockResolvedValue(undefined);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

async function render(isGroupConversation = false) {
  const c = mount(ChatGroupPanel, {
    target: document.body,
    props: {
      effectiveDisplayName: 'Peer',
      contactName: 'peer',
      groupId: G,
      isGroupConversation,
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

const callsGroup = () =>
  document.querySelector<HTMLElement>('[role="radiogroup"][aria-labelledby="group-calls-heading"]');
const callsRadio = (label: string) =>
  [...(callsGroup()?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])].find(
    (b) => (b.textContent ?? '').trim() === label
  );

describe('ChatGroupPanel call permission', () => {
  it('follows the level while the account never chose: a DM at none does not ring', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: { [G]: 'none' },
      groupCalls: {},
    });
    await render();
    expect(callsRadio(m.chat_calls_permission_refused_label())?.getAttribute('aria-checked')).toBe(
      'true'
    );
  });

  it('writes a choice for this conversation', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: {},
      groupCalls: {},
    });
    await render();
    callsRadio(m.chat_calls_permission_refused_label())!.click();
    await tick();
    flushSync();
    expect(api.saveGroupCallsAllowed).toHaveBeenCalledWith(G, false);
    expect(callsRadio(m.chat_calls_permission_refused_label())?.getAttribute('aria-checked')).toBe(
      'true'
    );
  });

  it('says so, and puts it back, when the server refuses the choice', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: {},
      groupCalls: {},
    });
    api.saveGroupCallsAllowed.mockRejectedValueOnce(new Error('403'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await render();
    callsRadio(m.chat_calls_permission_refused_label())!.click();
    for (let i = 0; i < 3; i++) await tick();
    flushSync();
    expect(callsRadio(m.chat_calls_permission_allowed_label())?.getAttribute('aria-checked')).toBe(
      'true'
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      m.chat_calls_permission_save_error()
    );
    expect(warn).toHaveBeenCalled();
  });

  it('is not offered in a group, where no call can be placed', async () => {
    api.fetchNotificationPreferences.mockResolvedValue({
      disabled: [],
      groupLevels: {},
      groupCalls: {},
    });
    await render(true);
    expect(callsGroup()).toBeNull();
  });
});
