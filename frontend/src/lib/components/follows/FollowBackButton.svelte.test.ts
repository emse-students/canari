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
  getAssociationFollowStatus: vi.fn(),
  unfollowAssociation: vi.fn(),
  listMyFollowedAssociations: vi.fn(),
  ensureMyAssociations: vi.fn(),
  didMyAssociationsProbeFail: vi.fn(() => false),
}));
const nav = vi.hoisted(() => ({ before: null as null | (() => void) }));
vi.mock('$app/navigation', () => ({
  beforeNavigate: (cb: () => void) => {
    nav.before = cb;
  },
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

import FollowBackButton from './FollowBackButton.svelte';
import { resetFollowState } from '$lib/follows/followState.svelte';
import { m } from '$lib/paraglide/messages';

let component: ReturnType<typeof mount> | null = null;

async function settle() {
  for (let i = 0; i < 8; i++) {
    await tick();
    await Promise.resolve();
    flushSync();
  }
}

async function render(userId: string) {
  component = mount(FollowBackButton, { target: document.body, props: { userId, name: 'X' } });
  await settle();
}

const btn = () => document.querySelector<HTMLButtonElement>('[data-follow-back]');

beforeEach(() => {
  vi.clearAllMocks();
  resetFollowState();
  blocks.listBlockedUsers.mockResolvedValue([]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

describe('Suivre en retour', () => {
  it('offers the follow, a tap asks, and the button then reads the request', async () => {
    api.getFollowStatuses.mockResolvedValue({});
    api.askToFollow.mockResolvedValue('pending');
    await render('u1');
    expect(btn()?.dataset.followBack).toBe('follow_back');
    expect(btn()?.textContent).toContain(m.follow_back_btn());
    expect(btn()?.getAttribute('aria-label')).toBe(m.follow_back_named({ name: 'X' }));
    btn()!.click();
    await settle();
    expect(api.askToFollow).toHaveBeenCalledWith('u1');
    expect(btn()?.dataset.followBack).toBe('requested');
    expect(btn()?.textContent).toContain(m.profile_follow_requested_btn());
  });

  it('shows the follow when the server answers accepted to the tap', async () => {
    api.getFollowStatuses.mockResolvedValue({});
    api.askToFollow.mockResolvedValue('accepted');
    await render('u1');
    btn()!.click();
    await settle();
    expect(btn()?.dataset.followBack).toBe('following');
    expect(btn()?.disabled).toBe(true);
    expect(btn()?.textContent).toContain(m.profile_public_following_btn());
  });

  it('a tap on the request withdraws it and the offer comes back', async () => {
    api.getFollowStatuses.mockResolvedValue({});
    api.askToFollow.mockResolvedValue('pending');
    api.withdrawFollowRequest.mockResolvedValue(undefined);
    await render('u1');
    btn()!.click();
    await settle();
    btn()!.click();
    await settle();
    expect(api.withdrawFollowRequest).toHaveBeenCalledWith('u1');
    expect(btn()?.dataset.followBack).toBe('follow_back');
  });

  it('draws nothing when already following, already pending, blocked, or the reader', async () => {
    api.getFollowStatuses.mockResolvedValue({ a: 'accepted', p: 'pending' });
    await render('a');
    expect(btn()).toBeNull();
    unmount(component!);
    await render('p');
    expect(btn()).toBeNull();
    unmount(component!);
    await render('me');
    expect(btn()).toBeNull();
    unmount(component!);
    blocks.listBlockedUsers.mockResolvedValue([{ userId: 'b' }]);
    resetFollowState();
    api.getFollowStatuses.mockResolvedValue({});
    await render('b');
    expect(btn()).toBeNull();
  });
});
