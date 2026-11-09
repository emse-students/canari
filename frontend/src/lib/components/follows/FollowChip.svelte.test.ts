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
  withdrawFollowRequest: vi.fn(),
  getFollowStatuses: vi.fn(),
}));
vi.mock('$lib/follows/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...api,
}));
const asso = vi.hoisted(() => ({
  followAssociation: vi.fn(),
  unfollowAssociation: vi.fn(),
  listMyFollowedAssociations: vi.fn(),
  ensureMyAssociations: vi.fn(),
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
const conn = vi.hoisted(() => ({
  reconnect: null as null | (() => void),
}));
vi.mock('$lib/stores/connectivity.svelte', () => ({
  connectivity: {
    onReconnect: (l: () => void) => {
      conn.reconnect = l;
      return () => {};
    },
  },
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('$lib/stores/toast.svelte', () => toast);
vi.mock('$lib/stores/user', () => ({ currentUserId: () => 'me' }));

import FollowChip from './FollowChip.svelte';
import { resetFollowState } from '$lib/follows/followState.svelte';
import { forgetReaderCaches } from '$lib/utils/sharedCache';
import {
  FOLLOW_BLOCKED,
  FOLLOW_REQUEST_ANSWERED,
  FOLLOW_REQUEST_NOT_FOUND,
} from '$lib/follows/api';
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
  asso.ensureMyAssociations.mockResolvedValue([]);
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
    api.withdrawFollowRequest.mockResolvedValue(undefined);
    await render('user', 'u1');
    expect(chip()?.getAttribute('aria-label')).toBe(m.follow_chip_withdraw_named({ name: 'X' }));
    chip()!.click();
    await settle();
    expect(api.withdrawFollowRequest).toHaveBeenCalledWith('u1');
    expect(api.leaveFollow).not.toHaveBeenCalled();
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

describe('a withdraw that raced the other side', () => {
  it('an acceptance meanwhile leaves a FOLLOW: the chip goes away, no toast, nothing unfollowed', async () => {
    api.getFollowStatuses.mockResolvedValue({ u1: 'pending' });
    api.withdrawFollowRequest.mockRejectedValue(
      new ApiRefusalError(409, FOLLOW_REQUEST_ANSWERED, 'x')
    );
    await render('user', 'u1');
    chip()!.click();
    await settle();
    expect(chip()).toBeNull();
    expect(toast.showToast).not.toHaveBeenCalled();
    expect(api.leaveFollow).not.toHaveBeenCalled();
  });

  it('a refusal by the other side leaves none: Suivre again, no toast, no stuck state', async () => {
    api.getFollowStatuses.mockResolvedValue({ u1: 'pending' });
    api.withdrawFollowRequest.mockRejectedValue(
      new ApiRefusalError(404, FOLLOW_REQUEST_NOT_FOUND, 'x')
    );
    await render('user', 'u1');
    chip()!.click();
    await settle();
    expect(chip()?.dataset.followChipState).toBe('ask');
    expect(toast.showToast).not.toHaveBeenCalled();
  });

  it('a second tap while the first is out does nothing', async () => {
    api.getFollowStatuses.mockResolvedValue({});
    api.askToFollow.mockReturnValue(new Promise(() => {}));
    await render('user', 'u1');
    chip()!.click();
    await settle();
    chip()!.click();
    await settle();
    expect(api.askToFollow).toHaveBeenCalledTimes(1);
  });
});

describe('a read that fails', () => {
  it('is asked ONCE, not again - the failure does not re-trigger its own readers', async () => {
    api.getFollowStatuses.mockRejectedValue(new Error('offline'));
    await render('user', 'u1');
    await settle();
    await settle();
    expect(api.getFollowStatuses).toHaveBeenCalledTimes(1);
    expect(chip()).toBeNull();
  });

  it('is asked again exactly once when the connection comes back', async () => {
    api.getFollowStatuses.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
    await render('user', 'u1');
    expect(api.getFollowStatuses).toHaveBeenCalledTimes(1);
    conn.reconnect!();
    await settle();
    await settle();
    expect(api.getFollowStatuses).toHaveBeenCalledTimes(2);
    expect(chip()?.dataset.followChipState).toBe('ask');
  });

  it('failed associations are asked once too, and again on the reconnect', async () => {
    asso.listMyFollowedAssociations.mockRejectedValueOnce(new Error('502'));
    await render('association', 'a1');
    await settle();
    expect(asso.listMyFollowedAssociations).toHaveBeenCalledTimes(1);
    conn.reconnect!();
    await settle();
    expect(asso.listMyFollowedAssociations).toHaveBeenCalledTimes(2);
    expect(chip()).not.toBeNull();
  });
});

describe('another account', () => {
  it('an answer in flight for account A never lands in B, and B asks for itself', async () => {
    let answerA!: (v: Record<string, string>) => void;
    api.getFollowStatuses
      .mockReturnValueOnce(new Promise((r) => (answerA = r)))
      .mockResolvedValueOnce({});
    await render('user', 'u1');
    forgetReaderCaches(); // the account switch
    answerA({ u1: 'accepted' });
    await settle();
    await settle();
    // B's own read was asked, and its answer (none) is what the chip draws - not A's 'accepted'.
    expect(api.getFollowStatuses).toHaveBeenCalledTimes(2);
    expect(chip()?.dataset.followChipState).toBe('ask');
  });

  it('forgets the previous account state at once', async () => {
    api.getFollowStatuses.mockResolvedValue({ u1: 'accepted' });
    await render('user', 'u1');
    forgetReaderCaches();
    api.getFollowStatuses.mockResolvedValue({});
    await settle();
    expect(chip()?.dataset.followChipState).toBe('ask');
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

  it('draws nothing for an association the reader belongs to', async () => {
    asso.ensureMyAssociations.mockResolvedValue([{ id: 'a1' }]);
    await render('association', 'a1');
    expect(chip()).toBeNull();
  });

  it('draws nothing for an archived association', async () => {
    component = mount(FollowChip, {
      target: document.body,
      props: { kind: 'association', targetId: 'a1', archived: true },
    });
    await settle();
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
