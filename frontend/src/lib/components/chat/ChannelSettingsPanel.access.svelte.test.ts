/**
 * EVERY CONTROL ON THE ACCESS TAB IS WRITTEN WHEN IT CHANGES, AND IT BELONGS TO ONE CHANNEL.
 *
 * Two defects met on production 2026-09-27. "Ajouter" appended to a local list that only
 * "Enregistrer" sent, while the trash beside each row removed on the server at once - a member was
 * added, the page reloaded, and the server had never been asked (no `PATCH /access` in five hours of
 * edge log). And the reset meant to run when the panel closed was guarded by `!open`, which resolved
 * to `window.open` and never ran: the panel is not remounted when the channel changes, so the access
 * tab kept the previous salon's allowlist, ready to be saved onto the next one.
 *
 * "Enregistrer" is gone (2026-09-28): the visibility toggle and the write-policy pick now save
 * themselves too, the same way the allowlist already did - the toggle behind a confirmation, since
 * flipping it changes who can read the channel; the write policy without one, like `setNotifLevel`.
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
const admitSalonGrantee = vi.hoisted(() => vi.fn().mockResolvedValue({ kind: 'not-held' }));
vi.mock('$lib/utils/graine/admitNewcomer', () => ({ admitSalonGrantee }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({ appendLog: vi.fn() }));
const showConfirmMock = vi.hoisted(() => vi.fn());
vi.mock('$lib/stores/confirm.svelte', () => ({ showConfirm: showConfirmMock }));
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
  showConfirmMock.mockReset().mockResolvedValue(true);
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

    // No write policy sent: that control saves itself, independently, see below.
    expect(service.updateChannelAccess).toHaveBeenCalledWith('salon-a', true, ['owner', 'peer']);
    // The field is cleared, not left showing a pick that was already taken.
    expect(input.value).toBe('');
    // Whoever admits a newcomer Welcomes them (channel-encryption section 20): the grant is
    // followed by the admission into the salon's own key group, after the server accepted it.
    expect(admitSalonGrantee).toHaveBeenCalledWith('salon-a', 'peer', expect.any(Function));
  });

  it('reloads the access settings when the panel moves to another salon', async () => {
    const props = await mountOnAccessTab('salon-a');
    expect(service.getChannelAccess).toHaveBeenLastCalledWith('salon-a');

    props.selectedChannelId = 'salon-b';
    await settle();

    expect(service.getChannelAccess).toHaveBeenLastCalledWith('salon-b');
  });

  it('confirms before flipping visibility, then writes it at once and reveals the allowlist', async () => {
    await mountOnAccessTab('public-salon');
    expect(document.getElementById('channel-access-autocomplete')).toBeNull();

    (document.querySelector('button[role=switch]') as HTMLButtonElement).click();
    await settle();

    expect(showConfirmMock).toHaveBeenCalledWith(m.chat_channel_make_private_confirm(), {
      danger: false,
    });
    expect(service.updateChannelAccess).toHaveBeenCalledWith('public-salon', true, []);
    expect(document.getElementById('channel-access-autocomplete')).not.toBeNull();
  });

  it('flips nothing when the visibility confirmation is cancelled', async () => {
    showConfirmMock.mockResolvedValue(false);
    await mountOnAccessTab('public-salon');

    (document.querySelector('button[role=switch]') as HTMLButtonElement).click();
    await settle();

    expect(service.updateChannelAccess).not.toHaveBeenCalled();
    expect(document.getElementById('channel-access-autocomplete')).toBeNull();
  });

  it('writes the write policy the moment it changes, with no confirmation asked', async () => {
    await mountOnAccessTab('salon-a');

    const select = document.querySelector('select') as HTMLSelectElement;
    select.value = 'admins';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();

    expect(showConfirmMock).not.toHaveBeenCalled();
    expect(service.updateChannelAccess).toHaveBeenCalledWith('salon-a', true, ['owner'], 'admins');
  });
});
