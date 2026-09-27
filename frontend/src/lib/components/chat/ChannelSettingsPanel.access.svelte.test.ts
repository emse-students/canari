/**
 * THE PRIVATE-SALON ALLOWLIST IS WRITTEN WHEN IT CHANGES, AND IT BELONGS TO ONE CHANNEL.
 *
 * Two defects met on production 2026-09-27. "Ajouter" appended to a local list that only
 * "Enregistrer" sent, while the trash beside each row removed on the server at once - a member was
 * added, the page reloaded, and the server had never been asked (no `PATCH /access` in five hours of
 * edge log). And the reset meant to run when the panel closed was guarded by `!open`, which resolved
 * to `window.open` and never ran: the panel is not remounted when the channel changes, so the access
 * tab kept the previous salon's allowlist, ready to be saved onto the next one.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const service = vi.hoisted(() => ({
  getChannelAccess: vi.fn(),
  updateChannelAccess: vi.fn(),
  listMembers: vi.fn(),
  getNotificationLevel: vi.fn(),
  removeMemberFromChannel: vi.fn(),
}));

vi.mock('$lib/services/ChannelService', () => ({ channelService: service }));
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify([{ id: 'peer', displayName: 'Peer Person' }]), { status: 200 })
    )
  ),
}));

import ChannelSettingsPanel from './ChannelSettingsPanel.svelte';
import { m } from '$lib/paraglide/messages';

const workspaces = [
  {
    id: 'ws',
    name: 'Community',
    channels: [
      { id: 'salon-a', name: 'a', isPrivate: true },
      { id: 'salon-b', name: 'b', isPrivate: true },
    ],
  },
];

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  service.getChannelAccess.mockImplementation((id: string) =>
    Promise.resolve({
      channelId: id,
      isPrivate: id !== 'public-salon',
      allowedUsers: id === 'salon-b' ? ['other'] : id === 'public-salon' ? [] : ['owner'],
      writePolicy: 'everyone',
    })
  );
  service.updateChannelAccess.mockResolvedValue({ ok: true });
  service.listMembers.mockResolvedValue([
    { id: '1', userId: 'owner', role: 'admin', joinedAt: '' },
    { id: '2', userId: 'peer', role: 'member', joinedAt: '' },
  ]);
  service.getNotificationLevel.mockResolvedValue('all');
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** Lets every pending promise and effect run. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

function buttonByText(text: string): HTMLButtonElement {
  const b = [...document.querySelectorAll('button')].find((x) =>
    (x.textContent ?? '').includes(text)
  );
  if (!b) throw new Error(`no button "${text}"`);
  return b as HTMLButtonElement;
}

async function mountOnAccessTab(channelId: string) {
  const props = $state({
    selectedChannelId: channelId,
    channelWorkspaces: [
      ...workspaces,
      { id: 'ws2', name: 'Other', channels: [{ id: 'public-salon', name: 'p' }] },
    ],
    onClose: () => {},
  });
  const instance = mount(ChannelSettingsPanel, { target: document.body, props });
  mounted.push(() => unmount(instance));
  flushSync();
  buttonByText(m.chat_channel_access_tab()).click();
  await settle();
  return props;
}

describe('ChannelSettingsPanel - access tab', () => {
  it('writes the allowlist on the server the moment a member is added', async () => {
    await mountOnAccessTab('salon-a');

    const input = document.getElementById('channel-access-autocomplete') as HTMLInputElement;
    input.value = 'Peer';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(350);
    await settle();
    const option = document.querySelector('[role=option]');
    expect(option).not.toBeNull();
    option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await settle();

    buttonByText(m.common_add_button()).click();
    await settle();

    // As the server holds it (private), with no write policy: that one stays with "Enregistrer".
    expect(service.updateChannelAccess).toHaveBeenCalledWith('salon-a', true, ['owner', 'peer']);
    // The field is cleared, not left showing a pick that was already taken.
    expect(input.value).toBe('');
  });

  it('reloads the access settings when the panel moves to another salon', async () => {
    const props = await mountOnAccessTab('salon-a');
    expect(service.getChannelAccess).toHaveBeenLastCalledWith('salon-a');

    props.selectedChannelId = 'salon-b';
    await settle();

    expect(service.getChannelAccess).toHaveBeenLastCalledWith('salon-b');
  });

  it('offers no allowlist on a salon the server does not yet hold private', async () => {
    await mountOnAccessTab('public-salon');

    (document.querySelector('button[role=switch]') as HTMLButtonElement).click();
    await settle();

    expect(document.body.textContent).toContain(m.chat_channel_private_save_first_hint());
    expect(document.getElementById('channel-access-autocomplete')).toBeNull();
  });
});
