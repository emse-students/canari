// @vitest-environment happy-dom
/**
 * THE "SUIVRE" CHIP (engagement WP-2): offered only where there is something to follow, a request
 * for a person and an immediate follow for an association, and put back with a toast on a refusal.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';

const api = vi.hoisted(() => ({
  askToFollow: vi.fn(),
  leaveFollow: vi.fn(),
  getFollowStatuses: vi.fn(),
}));
vi.mock('$lib/follows/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));
const asso = vi.hoisted(() => ({
  followAssociation: vi.fn(),
  listMyFollowedAssociations: vi.fn(),
}));
vi.mock('$lib/associations/api', () => asso);
const blocks = vi.hoisted(() => ({
  listBlockedUsers: vi.fn(),
  onBlocksChanged: vi.fn((l: () => void) => {
    blocks.listener = l;
    return () => {};
  }),
  listener: null as null | (() => void),
}));
vi.mock('$lib/users/blocks', () => blocks);
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => toast);
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'me' }));

import FollowChip from './FollowChip.svelte';
import { resetFollowState } from '$lib/follows/followState.svelte';
import { FOLLOW_BLOCKED } from '$lib/follows/api';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;

async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render(kind: 'user' | 'association', targetId: string) {
  component = mount(FollowChip, { target: document.body, props: { kind, targetId, name: 'X' } });
  await settle();
}

const chip = () => document.querySelector<HTMLButtonElement>('[data-follow-chip]');

beforeEach(() => {
  vi.clearAllMocks();
  resetFollowState();
  blocks.listBlockedUsers.mockResolvedValue([]);
  asso.listMyFollowedAssociations.mockResolvedValue([]);
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('a person', () => {
  it('offers Suivre when not followed, and a tap asks and shows the request', async () => {
    api.getFollowStatuses.mockResolvedValue({});
    api.askToFollow.mockResolvedValue('pending');
    await render('user', 'u1');
    expect(chip()?.dataset.followChipState).toBe('ask');
    chip()!.click();
    await settle();
    expect(api.askToFollow).toHaveBeenCalledWith('u1');
    expect(chip()?.dataset.followChipState).toBe('pending');
    expect(chip()?.textContent).toContain(m.profile_follow_requested_btn());
  });

  it('a tap on the request withdraws it', async () => {
    api.getFollowStatuses.mockResolvedValue({ u1: 'pending' });
    api.leaveFollow.mockResolvedValue(undefined);
    await render('user', 'u1');
    chip()!.click();
    await settle();
    expect(api.leaveFollow).toHaveBeenCalledWith('u1');
    expect(chip()?.dataset.followChipState).toBe('ask');
  });

  it('draws nothing for an accepted follow, yourself, a blocked account, or while unknown', async () => {
    api.getFollowStatuses.mockResolvedValue({ u1: 'accepted' });
    await render('user', 'u1');
    expect(chip()).toBeNull();
    unmount(component!);
    await render('user', 'me');
    expect(chip()).toBeNull();
    unmount(component!);
    blocks.listBlockedUsers.mockResolvedValue([{ userId: 'u2' }]);
    resetFollowState();
    api.getFollowStatuses.mockResolvedValue({});
    await render('user', 'u2');
    expect(chip()).toBeNull();
    unmount(component!);
    resetFollowState();
    api.getFollowStatuses.mockReturnValue(new Promise(() => {}));
    await render('user', 'u3');
    expect(chip()).toBeNull();
  });

  it('puts the chip back with the refusal sentence when the server refuses', async () => {
    api.getFollowStatuses.mockResolvedValue({});
    api.askToFollow.mockRejectedValue(new ApiRefusalError(403, FOLLOW_BLOCKED, 'x'));
    await render('user', 'u1');
    chip()!.click();
    await settle();
    expect(chip()?.dataset.followChipState).toBe('ask');
    expect(toast.showToast).toHaveBeenCalledWith(m.refusal_follow_blocked());
  });

  it('reads each person once however many chips name them', async () => {
    api.getFollowStatuses.mockResolvedValue({});
    await render('user', 'u1');
    const second = mount(FollowChip, {
      target: document.body,
      props: { kind: 'user', targetId: 'u1' },
    });
    await settle();
    expect(api.getFollowStatuses).toHaveBeenCalledTimes(1);
    unmount(second);
  });
});

describe('batching', () => {
  it('N chips in one render are ONE request, the same person once', async () => {
    api.getFollowStatuses.mockResolvedValue({ u2: 'pending' });
    const mounts = ['u1', 'u2', 'u3', 'u1'].map((id) =>
      mount(FollowChip, { target: document.body, props: { kind: 'user', targetId: id } })
    );
    await settle();
    expect(api.getFollowStatuses).toHaveBeenCalledTimes(1);
    expect(api.getFollowStatuses).toHaveBeenCalledWith(['u1', 'u2', 'u3']);
    expect(document.querySelectorAll('[data-follow-chip-state="pending"]').length).toBe(1);
    mounts.forEach((c) => unmount(c));
  });

  it('splits above the server cap, one call per hundred', async () => {
    api.getFollowStatuses.mockResolvedValue({});
    const mounts = Array.from({ length: 205 }, (_, i) =>
      mount(FollowChip, { target: document.body, props: { kind: 'user', targetId: `p${i}` } })
    );
    await settle();
    expect(api.getFollowStatuses.mock.calls.map((c) => c[0].length)).toEqual([100, 100, 5]);
    mounts.forEach((c) => unmount(c));
  });

  it('does not ask again for what the session already read', async () => {
    api.getFollowStatuses.mockResolvedValue({});
    await render('user', 'u1');
    unmount(component!);
    await render('user', 'u1');
    expect(api.getFollowStatuses).toHaveBeenCalledTimes(1);
  });

  it('a block drops what was read and a chip on screen asks again', async () => {
    api.getFollowStatuses.mockResolvedValueOnce({ u1: 'accepted' }).mockResolvedValueOnce({});
    await render('user', 'u1');
    expect(chip()).toBeNull();
    blocks.listener!();
    await settle();
    expect(api.getFollowStatuses).toHaveBeenCalledTimes(2);
    expect(chip()?.dataset.followChipState).toBe('ask');
  });
});

describe('an association', () => {
  it('offers Suivre when not followed, and a tap follows at once and removes the chip', async () => {
    asso.followAssociation.mockResolvedValue({ ok: true });
    await render('association', 'a1');
    chip()!.click();
    await settle();
    expect(asso.followAssociation).toHaveBeenCalledWith('a1');
    expect(chip()).toBeNull();
  });

  it('draws nothing for an association already followed', async () => {
    asso.listMyFollowedAssociations.mockResolvedValue([{ id: 'a1' }]);
    await render('association', 'a1');
    expect(chip()).toBeNull();
  });

  it('comes back with a toast when the follow fails', async () => {
    asso.followAssociation.mockRejectedValue(new Error('down'));
    await render('association', 'a1');
    chip()!.click();
    await settle();
    expect(chip()).not.toBeNull();
    expect(toast.showToast).toHaveBeenCalled();
  });
});
