// @vitest-environment happy-dom
/**
 * SLOW-LINK CHANTIER, GAP 2: A PROFILE ALREADY OPENED DRAWS FROM THE DEVICE while its read answers
 * nothing - the person's name on screen, no spinner over it, and the follow gesture waiting for the
 * answer (a copy holds no verdict about the reader). A failed revalidation keeps the copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { UserProfile } from '$lib/stores/user';
import { flushMacrotask } from '../../../test/flush';

const sealed = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));
const reads = vi.hoisted(() => ({ profile: vi.fn(), follow: vi.fn(), blocks: vi.fn() }));

vi.mock('$lib/db', () => ({
  getStorage: async (userId: string) => ({
    saveFeedPage: async (key: string, payload: unknown) => {
      sealed.rows.set(`${userId}/${key}`, JSON.parse(JSON.stringify(payload)));
    },
    getFeedPage: async (key: string) => sealed.rows.get(`${userId}/${key}`) ?? null,
    deleteFeedPage: async (key: string) => (sealed.rows.delete(`${userId}/${key}`) ? 1 : 0),
  }),
}));
vi.mock('$app/state', () => ({
  page: { params: { id: 'peer-1' }, url: new URL('https://canari.test/profile/peer-1'), state: {} },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
// The token never comes: the session refresh is still on the wire.
vi.mock('$lib/stores/auth', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getToken: () => new Promise(() => {}),
}));
vi.mock('$lib/stores/user', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getSavedUserId: () => 'me',
  fetchUserProfile: reads.profile,
}));
vi.mock('$lib/follows/api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFollowStatus: reads.follow,
}));
vi.mock('$lib/users/blocks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listBlockedUsers: reads.blocks,
}));
vi.mock('$lib/profile/api', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchUserMemberships: () => new Promise(() => {}),
  fetchUserRoleHistory: () => new Promise(() => {}),
  fetchUserParrainage: () => new Promise(() => {}),
}));

vi.mock(
  '$lib/components/profile/ProfileBioMarkdown.svelte',
  async () => import('../../../test/stubs/MountCounter.svelte')
);

vi.mock(
  '$lib/components/profile/ProfileHeader.svelte',
  async () => import('../../../test/stubs/ProfileHeaderStub.svelte')
);

import Page from './+page.svelte';
import { bindLocalCopies } from '$lib/localCopies/localCopyStore.svelte';
import { rememberProfile } from '$lib/profile/profileCopies';

const ME = { userId: 'me', deviceKeyB64: 'KEY' };
const mounted: (() => void)[] = [];

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  localStorage.clear();
  sealed.rows.clear();
  reads.profile.mockReset().mockReturnValue(new Promise(() => {}));
  reads.follow.mockReset().mockReturnValue(new Promise(() => {}));
  reads.blocks.mockReset().mockReturnValue(new Promise(() => {}));
  // A previous launch opened this profile and sealed it.
  bindLocalCopies(null);
  bindLocalCopies(ME);
  await rememberProfile({
    profile: { id: 'peer-1', displayName: 'Alice Martin', bio: 'Hello' } as unknown as UserProfile,
    memberships: [],
    roleHistory: [],
  });
  await flushMacrotask();
  bindLocalCopies({ userId: 'other', deviceKeyB64: 'K2' });
  await flushMacrotask();
  bindLocalCopies(null);
});
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function render(): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Page, { target });
  mounted.push(() => void unmount(app));
  await flushMacrotask();
  flushSync();
  return target;
}

describe('a profile already opened, on a link that answers nothing', () => {
  it('draws the person from the device with no spinner, and holds the follow gesture', async () => {
    const target = await render();
    // The key is not in hand yet: a locked device draws nothing from the copy.
    expect(target.textContent).not.toContain('Alice Martin');

    bindLocalCopies(ME);
    await flushMacrotask();
    flushSync();
    expect(target.textContent).toContain('Alice Martin');
    expect(target.querySelector('.animate-spin')).toBeNull();
    const follow = target.querySelector('[data-follow-status]') as HTMLButtonElement;
    expect(follow.disabled).toBe(true); // no verdict about the reader on a copy
  });

  it('keeps the copy on screen when the revalidation fails', async () => {
    let fail!: (e: unknown) => void;
    reads.profile.mockReset().mockReturnValue(new Promise((_, reject) => (fail = reject)));
    bindLocalCopies(ME);
    const target = await render();
    expect(target.textContent).toContain('Alice Martin');
    fail(new Error('timeout'));
    await flushMacrotask();
    flushSync();
    expect(target.textContent).toContain('Alice Martin');
    expect(target.querySelector('.animate-spin')).toBeNull();
  });
});
